import httpStatus from 'http-status';

import ApiError from '../utils/ApiError.js';
import User from '../models/user.model.js';
import Token from '../models/token.model.js';
import logger from '../config/logger.js';


/**
 * Create a user
 * @param {Object} userBody
 * @returns {Promise<User>}
 */
const createUser = async (userBody) => {
  if (await User.isEmailTaken(userBody.email)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }
  const user = await User.create(userBody);
  // Auto-create Student / Candidate profiles when user has those roles
  if (user.roleIds?.length) {
    // eslint-disable-next-line import/no-cycle
    const { ensureStudentProfileForUser } = await import('./student.service.js');
    await ensureStudentProfileForUser(user.id).catch(() => {});
    // eslint-disable-next-line import/no-cycle
    const { ensureCandidateProfileForUser } = await import('./candidate.service.js');
    await ensureCandidateProfileForUser(user.id).catch(() => {});
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
 * @returns {Promise<QueryResult>}
 */
const queryUsers = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [
      { name: { $regex: searchRegex } },
      { email: { $regex: searchRegex } },
    ];
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
    const { ensureCandidateProfileForUser } = await import('./candidate.service.js');
    await ensureCandidateProfileForUser(user.id).catch(() => {});
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
  const Candidate = (await import('../models/candidate.model.js')).default;
  const candidates = await Candidate.find({ owner: userId }).select('_id');
  if (candidates.length) {
    const candidateIds = candidates.map((c) => c._id);
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    await JobApplication.deleteMany({ candidate: { $in: candidateIds } });
    await Candidate.deleteMany({ owner: userId });
  }

  // --- Delete job applications submitted by this user directly ---
  const JobApplication = (await import('../models/jobApplication.model.js')).default;
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
  getUserByEmail,
  updateUserById,
  deleteUserById,
};

