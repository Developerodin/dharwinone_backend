import httpStatus from 'http-status';

import ApiError from '../utils/ApiError.js';
import { SALES_AGENT_ROLE_NAMES, userHasRecruiterRole } from '../utils/roleHelpers.js';
import User from '../models/user.model.js';
import { viewerSeesHiddenUsers, getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';
import Token from '../models/token.model.js';
import logger from '../config/logger.js';
import { collationForSortBy } from '../utils/mongoCollation.js';

const FILTER_OPTIONS_LIMIT = 500;
const FILTER_OPTIONS_SCAN_LIMIT = 2000;
const RECRUITER_EXPORT_MAX_ROWS = 10000;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseStringList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const appendAndClause = (mongoFilter, clause) => {
  mongoFilter.$and = [...(mongoFilter.$and || []), clause];
};

const applyUserFacetFilters = (mongoFilter, filter) => {
  const nameFilters = parseStringList(filter.names);
  if (nameFilters.length) {
    appendAndClause(mongoFilter, {
      $or: nameFilters.map((name) => ({
        name: { $regex: escapeRegex(name), $options: 'i' },
      })),
    });
  }

  const domainFilters = parseStringList(filter.domains);
  if (domainFilters.length) {
    appendAndClause(mongoFilter, {
      $or: domainFilters.map((domain) => ({
        domain: { $regex: escapeRegex(domain), $options: 'i' },
      })),
    });
  }

  const educationFilters = parseStringList(filter.education);
  if (educationFilters.length) {
    appendAndClause(mongoFilter, {
      $or: educationFilters.map((edu) => ({
        education: { $regex: escapeRegex(edu), $options: 'i' },
      })),
    });
  }

  const locationFilters = parseStringList(filter.locations);
  if (locationFilters.length) {
    appendAndClause(mongoFilter, {
      $or: locationFilters.map((loc) => ({
        location: { $regex: escapeRegex(loc), $options: 'i' },
      })),
    });
  }

  const emailFilters = parseStringList(filter.email);
  if (emailFilters.length) {
    appendAndClause(mongoFilter, {
      $or: emailFilters.map((value) => ({
        email: { $regex: escapeRegex(value), $options: 'i' },
      })),
    });
  }
};

const applyRoleScope = async (mongoFilter, role) => {
  if (role !== 'recruiter' && role !== 'referral_eligible' && role !== 'sales_agent') {
    return;
  }
  const Role = (await import('../models/role.model.js')).default;
  let roleQuery;
  if (role === 'sales_agent') {
    roleQuery = {
      status: 'active',
      $or: [
        { name: { $in: SALES_AGENT_ROLE_NAMES } },
        { slug: 'salesagent' },
        { name: { $regex: /^sales[\s_-]*agent$/i } },
      ],
    };
  } else {
    const targetRoles =
      role === 'recruiter'
        ? ['Recruiter']
        : ['Administrator', 'Agent', 'agent', 'Sales Agent', 'sales_agent'];
    roleQuery = { name: { $in: targetRoles }, status: 'active' };
  }
  const roles = await Role.find(roleQuery).select('_id').lean();
  if (roles.length > 0) {
    mongoFilter.roleIds = { $in: roles.map((r) => r._id) };
  } else {
    mongoFilter._id = { $in: [] };
  }
};

const applySearchFilter = (mongoFilter, search) => {
  if (!search || !search.trim()) return;
  const collapsed = search.trim().replace(/\s+/g, ' ');
  const escaped = collapsed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const searchRegex = new RegExp(escaped.replace(/ /g, '\\s+'), 'i');
  mongoFilter.$or = [{ name: { $regex: searchRegex } }, { email: { $regex: searchRegex } }];
};

const applyHiddenUserFilter = async (mongoFilter, requester) => {
  if (!requester || viewerSeesHiddenUsers(requester)) return;
  const hiddenIds = await getDirectoryHiddenUserIds();
  if (hiddenIds.length === 0) return;
  mongoFilter._id = { ...(mongoFilter._id || {}), $nin: hiddenIds };
};

/**
 * Build Mongo filter for GET /users list queries (recruiter facet filters, role scope, search).
 * @param {Object} filter
 * @param {object | null} [requester]
 */
const buildUserListMongoFilter = async (filter, requester = null) => {
  const { search, role, names, domains, education, locations, email, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };

  await applyRoleScope(mongoFilter, role);
  applyUserFacetFilters(mongoFilter, { names, domains, education, locations, email });
  applySearchFilter(mongoFilter, search);
  await applyHiddenUserFilter(mongoFilter, requester);

  return mongoFilter;
};

const collectRecruiterFilterFacets = (users) => {
  const names = new Set();
  const domains = new Set();
  const education = new Set();
  const locations = new Set();
  const emails = new Set();

  for (const user of users) {
    if (user.name?.trim()) names.add(user.name.trim());
    if (user.email?.trim()) emails.add(user.email.trim());
    if (user.education?.trim()) education.add(user.education.trim());
    if (user.location?.trim()) locations.add(user.location.trim());
    const domainValues = Array.isArray(user.domain) ? user.domain : user.domain ? [user.domain] : [];
    for (const domain of domainValues) {
      const trimmed = String(domain).trim();
      if (trimmed) domains.add(trimmed);
    }
  }

  const sortCi = (left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' });
  const cap = (values) => [...values].sort(sortCi).slice(0, FILTER_OPTIONS_LIMIT);

  return {
    names: cap(names),
    domains: cap(domains),
    education: cap(education),
    locations: cap(locations),
    emails: cap(emails),
  };
};

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
  const mongoFilter = await buildUserListMongoFilter(filter, requester);
  const users = await User.paginate(mongoFilter, {
    ...options,
    collation: collationForSortBy(options.sortBy, ['name', 'email', 'education', 'location']),
  });
  // Attach the company-assigned (official) email from each linked Employee profile so callers
  // (meeting / interview invites) can prefer it over the personal login email. Best-effort: a
  // failure here must never break the user list.
  try {
    const ownerIds = (users.results || []).map((u) => u._id).filter(Boolean);
    if (ownerIds.length) {
      const Employee = (await import('../models/employee.model.js')).default;
      const emps = await Employee.find({
        owner: { $in: ownerIds },
        companyAssignedEmail: { $nin: [null, ''] },
      })
        .select('owner companyAssignedEmail companyEmailProvider')
        .lean();
      if (emps.length) {
        const byOwner = new Map(emps.map((e) => [String(e.owner), e]));
        users.results = users.results.map((u) => {
          const obj = typeof u.toJSON === 'function' ? u.toJSON() : u;
          const emp = byOwner.get(String(obj.id || obj._id));
          if (emp) {
            obj.companyAssignedEmail = emp.companyAssignedEmail;
            obj.companyEmailProvider = emp.companyEmailProvider || '';
          }
          return obj;
        });
      }
    }
  } catch (err) {
    logger.warn(`queryUsers companyAssignedEmail enrich failed: ${err?.message || err}`);
  }
  return users;
};

/**
 * Distinct sidebar filter values for recruiters (scoped by role + optional search).
 */
const getRecruiterFilterOptions = async (filter = {}, requester = null) => {
  const mongoFilter = await buildUserListMongoFilter({ ...filter, role: 'recruiter' }, requester);
  const users = await User.find(mongoFilter)
    .select('name email education domain location')
    .limit(FILTER_OPTIONS_SCAN_LIMIT)
    .lean();
  return collectRecruiterFilterFacets(users);
};

/**
 * Export recruiters with the same filters/sort as the list view, capped for safety.
 */
const queryRecruitersForExport = async (filter, options = {}, requester = null) => {
  const firstPage = await queryUsers(
    { ...filter, role: 'recruiter' },
    { ...options, page: 1, limit: RECRUITER_EXPORT_MAX_ROWS },
    requester
  );
  const capped = firstPage.totalResults > RECRUITER_EXPORT_MAX_ROWS;
  return {
    results: firstPage.results,
    totalResults: firstPage.totalResults,
    capped,
    exportMax: RECRUITER_EXPORT_MAX_ROWS,
  };
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
  const pendingToActive = updateBody.status === 'active' && previousStatus === 'pending';
  // Captured pre-save: the Employee mirror is matched by email, and on an email change the
  // linked profile still carries the old one.
  const previousEmail = user.email;
  Object.assign(user, updateBody);
  if (pendingToActive) {
    user.activatedAt = new Date();
  }
  await user.save();

  // Keep linked Employee profile in sync with User (admin PATCH /users, PATCH /auth/me, etc.)
  const changedIdentity = {};
  for (const f of ['name', 'email', 'phoneNumber', 'countryCode', 'profilePicture']) {
    if (updateBody[f] !== undefined) changedIdentity[f] = user[f];
  }
  if (Object.keys(changedIdentity).length > 0) {
    // eslint-disable-next-line import/no-cycle -- employee.service imports user.service; sync is runtime-only
    const { syncIdentityFromUserToEmployee } = await import('./employee.service.js');
    try {
      await syncIdentityFromUserToEmployee(userId, changedIdentity, [previousEmail, user.email]);
    } catch (err) {
      logger.warn(`syncIdentityFromUserToEmployee failed for userId=${userId}: ${err?.message || err}`);
    }
  }

  // Send confirmation email when candidate account is activated by admin (pending -> active)
  if (pendingToActive && user.email) {
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

    // When admin assigns the HR Employee role from User Management, mint the persistent DBS<n>
    // employeeId on this user's Employee profile (idempotent — no-op if already assigned).
    try {
      const { getRoleByName } = await import('./role.service.js');
      const hrEmployeeRole = await getRoleByName('Employee');
      if (hrEmployeeRole?._id) {
        const hasHrEmployeeRole = (user.roleIds || []).some(
          (id) => id && id.toString() === hrEmployeeRole._id.toString()
        );
        if (hasHrEmployeeRole) {
          // eslint-disable-next-line import/no-cycle
          const { ensureEmployeeIdForOwner } = await import('./employeeRolePromotion.service.js');
          await ensureEmployeeIdForOwner(user.id);
        }
      }
    } catch (err) {
      logger.warn(`ensureEmployeeIdForOwner failed after updateUserById userId=${userId}: ${err?.message || err}`);
    }
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

  // --- Chatbot cascade: drop Pinecone embeddings, ConversationMemory refs,
  //     and per-admin context cache BEFORE removing the User row. Best-effort
  //     — failures here must not block the delete.
  try {
    const { cascadeUserRemoval } = await import('./chatAssistant/entityCleanup.js');
    await cascadeUserRemoval({ userId, adminId: user.adminId ?? user._id });
  } catch (err) {
    logger.warn(`[deleteUserById] cascadeUserRemoval failed for ${userId}: ${err.message}`);
  }

  // --- Delete the user ---
  await user.deleteOne();

  logger.info(`User ${userId} hard-deleted with all related data`);
  return user;
};

/**
 * Public recruiter profile (no auth). Only active users with the Recruiter role.
 * Returns a sanitized subset safe for external sharing.
 */
const getPublicRecruiterProfile = async (recruiterId) => {
  const user = await User.findById(recruiterId)
    .select(
      'name email phoneNumber countryCode education domain location profileSummary profilePicture status roleIds'
    )
    .lean();
  if (!user || user.status !== 'active') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recruiter not found');
  }
  const isRecruiter = await userHasRecruiterRole(user);
  if (!isRecruiter) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recruiter not found');
  }
  const profileUrl = user.profilePicture?.url;
  return {
    id: String(user._id),
    name: user.name || '',
    email: user.email || '',
    phoneNumber: user.phoneNumber || '',
    countryCode: user.countryCode || '',
    education: user.education || '',
    domain: Array.isArray(user.domain) ? user.domain.filter(Boolean) : [],
    location: user.location || '',
    profileSummary: user.profileSummary || '',
    profilePicture: profileUrl ? { url: profileUrl } : null,
  };
};

export {
  createUser,
  buildUserListMongoFilter,
  applyUserFacetFilters,
  parseStringList,
  queryUsers,
  getRecruiterFilterOptions,
  queryRecruitersForExport,
  RECRUITER_EXPORT_MAX_ROWS,
  getUserById,
  getUserByIdForRequester,
  getUserByEmail,
  updateUserById,
  deleteUserById,
  countPlatformSuperUsers,
  getPublicRecruiterProfile,
};

