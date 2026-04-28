import httpStatus from 'http-status';

import ApiError from '../utils/ApiError.js';
import User from '../models/user.model.js';
import { viewerSeesHiddenUsers, getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';
import Token from '../models/token.model.js';
import logger from '../config/logger.js';


/**
 * Create a user
 * @param {Object} userBody
 * @param {{ allowPrivilegedUserFields?: boolean }} [options] - When false (default), strips platformSuperUser/hideFromDirectory (public/register flows cannot self-elevate).
 * @returns {Promise<User>}
 */
const createUser = async (userBody, options = {}) => {
  const { allowPrivilegedUserFields = false } = options;
  const body = { ...userBody };
  if (!allowPrivilegedUserFields) {
    delete body.platformSuperUser;
    delete body.hideFromDirectory;
  }
  if (await User.isEmailTaken(body.email)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }
  const user = await User.create(body);
  // Auto-create Student / Candidate profiles when user has those roles
  if (user.roleIds?.length) {
    // eslint-disable-next-line import/no-cycle
    const { ensureStudentProfileForUser } = await import('./student.service.js');
    await ensureStudentProfileForUser(user.id).catch(() => {});
    // eslint-disable-next-line import/no-cycle
    const { ensureCandidateProfileForUser } = await import('./employee.service.js');
    await ensureCandidateProfileForUser(user.id).catch((err) => {
      logger.warn(`ensureCandidateProfileForUser failed after User.create userId=${user.id}: ${err?.message || err}`);
    });
  }
  return user;
};

/**
 * Query for users
 * @param {Object} filter - Mongo filter (name, role, status, search)
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @param {object | null} [requester] - req.user; when set and not platform super, excludes directory-hidden users
 * @returns {Promise<QueryResult>}
 */
const queryUsers = async (filter, options, requester = null) => {
  const { search, role, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (role === 'recruiter' || role === 'referral_eligible') {
    const Role = (await import('../models/role.model.js')).default;
    const targetRoles =
      role === 'recruiter'
        ? ['Recruiter']
        : ['Administrator', 'Agent', 'agent', 'Sales Agent', 'sales_agent'];
    const roles = await Role.find({ name: { $in: targetRoles }, status: 'active' }).select('_id').lean();
    if (roles.length > 0) {
      mongoFilter.roleIds = { $in: roles.map((r) => r._id) };
    } else {
      mongoFilter._id = { $in: [] };
    }
  }
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [
      { name: { $regex: searchRegex } },
      { email: { $regex: searchRegex } },
    ];
  }
  if (requester && !viewerSeesHiddenUsers(requester)) {
    const hiddenIds = await getDirectoryHiddenUserIds();
    if (hiddenIds.length > 0) {
      mongoFilter._id = { $nin: hiddenIds };
    }
  }
  const users = await User.paginate(mongoFilter, options);
  return users;
};

/**
 * Get user by id
 * @param {ObjectId} id
 * @returns {Promise<User>}
 */
const getUserById = async (id) => {
  return User.findById(id);
};

/**
 * Get user by id for an authenticated viewer. Hidden / platform-super targets are not discoverable (404) unless viewer is self or platform super.
 * @param {import('mongoose').Types.ObjectId|string} targetId
 * @param {object | null | undefined} viewer - req.user (mongoose doc or plain object with id/_id)
 * @returns {Promise<import('mongoose').Document>}
 */
const getUserByIdForRequester = async (targetId, viewer) => {
  const user = await User.findById(targetId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  const viewerId = viewer?._id != null ? viewer._id.toString() : viewer?.id != null ? String(viewer.id) : '';
  const targetStr = user._id.toString();
  if (viewerId && targetStr === viewerId) {
    return user;
  }
  if ((user.hideFromDirectory || user.platformSuperUser) && !viewer?.platformSuperUser) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  return user;
};

/**
 * @returns {Promise<number>}
 */
const countPlatformSuperUsers = async () => User.countDocuments({ platformSuperUser: true });

/**
 * Get user by email
 * @param {string} email
 * @returns {Promise<User>}
 */
const getUserByEmail = async (email) => {
  return User.findOne({ email });
};

/**
 * Update user by id
 * @param {ObjectId} userId
 * @param {Object} updateBody
 * @returns {Promise<User>}
 */
const updateUserById = async (userId, updateBody) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (updateBody.email && (await User.isEmailTaken(updateBody.email, userId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }
  const previousStatus = user.status;
  Object.assign(user, updateBody);
  await user.save();

  // Keep linked Candidate phone/country in sync with User (admin PATCH /users, etc.)
  if (updateBody.phoneNumber !== undefined || updateBody.countryCode !== undefined) {
    // eslint-disable-next-line import/no-cycle -- employee.service imports user.service; sync is runtime-only
    const { syncPhoneFromUserToCandidate } = await import('./employee.service.js');
    await syncPhoneFromUserToCandidate(userId, {
      ...(updateBody.phoneNumber !== undefined && { phoneNumber: user.phoneNumber }),
      ...(updateBody.countryCode !== undefined && { countryCode: user.countryCode }),
    });
  }

  // Send confirmation email when candidate account is activated by admin (pending -> active)
  if (updateBody.status === 'active' && previousStatus === 'pending' && user.email) {
    const { sendCandidateAccountActivationEmail } = await import('./email.service.js');
    sendCandidateAccountActivationEmail(user.email, user.name).catch((err) => {
      logger.warn(`Failed to send account activation email to ${user.email}: ${err?.message || err}`);
    });
    const cfg = await import('../config/config.js').then((m) => m.default);
    const signInUrl = `${(cfg?.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '')}/authentication/sign-in/`;
    const { notify } = await import('./notification.service.js');
    notify(user.id || user._id, {
      type: 'account',
      title: 'Your account has been activated',
      message: 'You can now sign in.',
      link: signInUrl,
    }).catch(() => {});
  }
  // Auto-create Student / Candidate profiles when user gains those roles
  if (user.roleIds?.length) {
    // eslint-disable-next-line import/no-cycle
    const { ensureStudentProfileForUser } = await import('./student.service.js');
    await ensureStudentProfileForUser(user.id).catch(() => {});
    // eslint-disable-next-line import/no-cycle
    const { ensureCandidateProfileForUser } = await import('./employee.service.js');
    await ensureCandidateProfileForUser(user.id).catch((err) => {
      logger.warn(`ensureCandidateProfileForUser failed after updateUserById userId=${userId}: ${err?.message || err}`);
    });
  }
  return user;
};

/**
 * Delete user by id — hard delete.
 * Cascade-deletes ALL related data: Student, Candidate, Attendance, JobApplications,
 * LeaveRequests, BackdatedAttendanceRequests, EmailAccounts, Notifications, Tokens, etc.
 * @param {ObjectId} userId
 * @returns {Promise<User>}
 */
const deleteUserById = async (userId) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  // --- Cascade delete Student and all student-linked data ---
  const Student = (await import('../models/student.model.js')).default;
  const student = await Student.findOne({ user: userId });
  if (student) {
    const studentId = student._id;
    const Attendance = (await import('../models/attendance.model.js')).default;
    const LeaveRequest = (await import('../models/leaveRequest.model.js')).default;
    const BackdatedAttendanceRequest = (await import('../models/backdatedAttendanceRequest.model.js')).default;
    const StudentCourseProgress = (await import('../models/studentCourseProgress.model.js')).default;
    const StudentQuizAttempt = (await import('../models/studentQuizAttempt.model.js')).default;
    const StudentEssayAttempt = (await import('../models/studentEssayAttempt.model.js')).default;
    const Certificate = (await import('../models/certificate.model.js')).default;

    await Promise.all([
      Attendance.deleteMany({ student: studentId }),
      LeaveRequest.deleteMany({ student: studentId }),
      BackdatedAttendanceRequest.deleteMany({ student: studentId }),
      StudentCourseProgress.deleteMany({ student: studentId }).catch(() => {}),
      StudentQuizAttempt.deleteMany({ student: studentId }).catch(() => {}),
      StudentEssayAttempt.deleteMany({ student: studentId }).catch(() => {}),
      Certificate.deleteMany({ student: studentId }).catch(() => {}),
    ]);

    await student.deleteOne();
  }

  // --- Cascade delete Candidate and candidate-linked data ---
  // Employee.email is globally unique; portal User.email matches the candidate row for self-serve signups.
  // Delete by owner OR by email so referral/ATS rows disappear even if owner was mis-set (legacy bugs).
  const Employee = (await import('../models/employee.model.js')).default;
  const JobApplication = (await import('../models/jobApplication.model.js')).default;
  const emailNorm = (user.email || '').trim().toLowerCase();
  const candidateMatch =
    emailNorm.length > 0
      ? { $or: [{ owner: userId }, { email: emailNorm }] }
      : { owner: userId };
  const candidates = await Employee.find(candidateMatch).select('_id').lean();
  if (candidates.length) {
    const candidateIds = candidates.map((c) => c._id);
    await JobApplication.deleteMany({ candidate: { $in: candidateIds } });
    await Employee.deleteMany({ _id: { $in: candidateIds } });
  }

  // --- Delete job applications submitted by this user directly ---
  await JobApplication.deleteMany({ appliedBy: userId }).catch(() => {});

  // --- Delete other user-owned data ---
  const EmailAccount = (await import('../models/emailAccount.model.js')).default;
  const Notification = (await import('../models/notification.model.js')).default;
  const Mentor = (await import('../models/mentor.model.js')).default;
  const Impersonation = (await import('../models/impersonation.model.js')).default;

  await Promise.all([
    EmailAccount.deleteMany({ user: userId }),
    Notification.deleteMany({ user: userId }),
    Mentor.deleteMany({ user: userId }).catch(() => {}),
    Impersonation.deleteMany({ $or: [{ adminUser: userId }, { impersonatedUser: userId }] }).catch(() => {}),
    Token.deleteMany({ user: userId }),
  ]);

  // --- Delete the user ---
  await user.deleteOne();

  logger.info(`User ${userId} hard-deleted with all related data`);
  return user;
};

export {
  createUser,
  queryUsers,
  getUserById,
  getUserByIdForRequester,
  getUserByEmail,
  updateUserById,
  deleteUserById,
  countPlatformSuperUsers,
};

