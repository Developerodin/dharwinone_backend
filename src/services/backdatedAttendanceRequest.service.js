import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import BackdatedAttendanceRequest from '../models/backdatedAttendanceRequest.model.js';
import Student from '../models/student.model.js';
import Attendance from '../models/attendance.model.js';
import User from '../models/user.model.js';
import pick from '../utils/pick.js';
import { userIsAdminOrAgent } from '../utils/roleHelpers.js';
import { getGrantingPermissions } from '../config/permissions.js';
import { getUserPermissionContext } from './permission.service.js';
import { findBlockedAttendanceDays } from './attendancePolicy.service.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Regularization is capped at one standard shift. Blocks bad spans like 09:00 -> 05:00 (20h). */
const MAX_SHIFT_MS = 8 * 60 * 60 * 1000;

/**
 * Ceiling on one request. A From–To range of years used to expand into thousands of
 * entries that approve then wrote one by one.
 * ponytail: flat cap, not a policy engine — raise the number if a real backfill needs more.
 */
const MAX_ENTRIES_PER_REQUEST = 62;

/**
 * Who may review (list all, view, update, approve, reject) a backdated request.
 *
 * One gate for the whole flow. It used to be three that disagreed: the nav link showed on
 * `attendance.assign`, the page checked the Administrator/Agent role name, and the mutate
 * routes required `students.manage` — so an Agent could open the page, click Approve and
 * get a 403. `attendance.assign` (= students.manage OR attendance.manage) is now the key
 * everywhere; the role check stays as a fallback so nobody with a sparse role matrix loses
 * access they had before.
 */
const canReviewRequests = async (user) => {
  if (user?.platformSuperUser) return true;
  const { permissions } = await getUserPermissionContext(user);
  if (getGrantingPermissions('attendance.assign').some((p) => permissions.has(p))) return true;
  return userIsAdminOrAgent(user);
};

/**
 * Legacy-data guard:
 * Some old requests may have both `student` and `user` set (or neither), which breaks
 * the model pre-save invariant. Normalize to exactly one identity before save.
 */
const normalizeRequestIdentity = async (requestDoc) => {
  const hasStudent = requestDoc.student != null;
  const hasUser = requestDoc.user != null;
  if (hasStudent !== hasUser) return requestDoc;

  if (hasStudent && hasUser) {
    // Prefer student-based request when student exists (historical default flow).
    requestDoc.user = undefined;
    requestDoc.userEmail = undefined;
    if (!requestDoc.studentEmail && requestDoc.student?.user?.email) {
      requestDoc.studentEmail = requestDoc.student.user.email;
    }
    return requestDoc;
  }

  // Neither set: infer from requester.
  const requesterId = requestDoc.requestedBy?._id ?? requestDoc.requestedBy;
  if (requesterId) {
    const student = await Student.findOne({ user: requesterId }).select('_id user email').populate('user', 'email');
    if (student?._id) {
      requestDoc.student = student._id;
      requestDoc.studentEmail = student.user?.email || student.email || requestDoc.studentEmail || '';
      requestDoc.user = undefined;
      requestDoc.userEmail = undefined;
      return requestDoc;
    }
    requestDoc.user = requesterId;
    if (!requestDoc.userEmail) {
      const u = await User.findById(requesterId).select('email').lean();
      requestDoc.userEmail = u?.email || '';
    }
    requestDoc.student = undefined;
    requestDoc.studentEmail = undefined;
  }

  // Final safety: ensure invariant before save even if requester/student lookups failed.
  const nowHasStudent = requestDoc.student != null;
  const nowHasUser = requestDoc.user != null;
  if (nowHasStudent === nowHasUser) {
    if (requesterId) {
      requestDoc.student = undefined;
      requestDoc.studentEmail = undefined;
      requestDoc.user = requesterId;
      if (!requestDoc.userEmail) {
        const u = await User.findById(requesterId).select('email').lean();
        requestDoc.userEmail = u?.email || requestDoc.userEmail || '';
      }
    } else {
      // No way to infer owner; fail with actionable message instead of pre-save generic 500.
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid backdated request identity: missing student/user owner');
    }
  }
  return requestDoc;
};

/**
 * Validate and normalize raw entries into the stored shape.
 *
 * One copy for create-for-student, create-for-user and reviewer update. The update path used
 * to skip the 8h cap entirely, so a direct PATCH could store a 20h span that approve then
 * happily wrote as Present.
 *
 * @param {Array} attendanceEntries
 * @returns {{ entries: Array, dates: Date[] }} `dates` are the UTC midnights, in input order
 */
const normalizeEntries = (attendanceEntries) => {
  if (!Array.isArray(attendanceEntries) || attendanceEntries.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one attendance entry is required');
  }
  if (attendanceEntries.length > MAX_ENTRIES_PER_REQUEST) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A backdated request can cover at most ${MAX_ENTRIES_PER_REQUEST} days. Split the range into smaller requests.`
    );
  }

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
  const entries = [];
  const seenDates = new Set();

  for (let i = 0; i < attendanceEntries.length; i++) {
    const entry = attendanceEntries[i];
    if (!entry.date || !entry.punchIn || !entry.punchOut) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: date, punchIn, and punchOut are required`);
    }

    const dateObj = new Date(entry.date);
    if (isNaN(dateObj.getTime())) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid date: ${entry.date}`);
    }
    const normalizedDate = new Date(
      Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate(), 0, 0, 0, 0)
    );

    if (normalizedDate >= todayUTC) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attendance entry ${i + 1}: Backdated attendance requests can only be made for past dates`
      );
    }

    const dateKey = normalizedDate.getTime();
    if (seenDates.has(dateKey)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attendance entry ${i + 1}: Duplicate date ${normalizedDate.toISOString().split('T')[0]} in the same request`
      );
    }
    seenDates.add(dateKey);

    let punchIn = new Date(entry.punchIn);
    if (isNaN(punchIn.getTime())) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchIn time: ${entry.punchIn}`);
    }
    const punchInDate = new Date(normalizedDate);
    punchInDate.setUTCHours(
      punchIn.getUTCHours(),
      punchIn.getUTCMinutes(),
      punchIn.getUTCSeconds(),
      punchIn.getUTCMilliseconds()
    );
    punchIn = punchInDate;

    let punchOut = null;
    if (entry.punchOut) {
      punchOut = new Date(entry.punchOut);
      if (isNaN(punchOut.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchOut time: ${entry.punchOut}`);
      }
      const punchOutDate = new Date(normalizedDate);
      punchOutDate.setUTCHours(
        punchOut.getUTCHours(),
        punchOut.getUTCMinutes(),
        punchOut.getUTCSeconds(),
        punchOut.getUTCMilliseconds()
      );
      punchOut = punchOutDate;
      if (punchOut <= punchIn) {
        const punchInHour = punchIn.getUTCHours();
        const punchOutHour = punchOut.getUTCHours();
        const hoursDifference = (punchOutHour + 24 - punchInHour) % 24;
        const isNightShift = (punchInHour >= 12 && punchOutHour < 12) || (hoursDifference >= 1 && hoursDifference <= 16);
        if (isNightShift) {
          punchOut.setUTCDate(punchOut.getUTCDate() + 1);
        } else {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Attendance entry ${i + 1}: Punch out time must be after punch in time`
          );
        }
      }
      if (punchOut - punchIn > MAX_SHIFT_MS) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Duration cannot exceed 8 hours`);
      }
    }

    entries.push({
      date: normalizedDate,
      punchIn,
      punchOut: punchOut || null,
      timezone: entry.timezone || 'UTC',
    });
  }

  return { entries, dates: entries.map((e) => e.date) };
};

/** Human-readable reason a day cannot take a backdated Present record. */
const describeBlockedDay = (blocked) => {
  const label = new Date(`${blocked.date}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  if (blocked.kind === 'holiday') return `${label} — holiday (${blocked.label})`;
  if (blocked.kind === 'leave') return `${label} — already marked as ${blocked.label}`;
  return `${label} — ${blocked.label} is a week off`;
};

/**
 * Refuse a request that covers a holiday, a recorded leave, or a week-off.
 * The requester is told which day and why up front, instead of an admin silently
 * overwriting the leave later at approve time.
 */
const assertDaysAreRequestable = async ({ studentId, userId, dates }) => {
  const blocked = await findBlockedAttendanceDays({ studentId, userId, dates });
  if (blocked.length === 0) return;
  throw new ApiError(
    httpStatus.BAD_REQUEST,
    `Backdated attendance cannot be requested for: ${blocked.map(describeBlockedDay).join('; ')}.`
  );
};

/** The UTC-midnight days a request covers, for conflict lookups. */
const requestDates = (request) =>
  (request.attendanceEntries || []).map((e) => {
    const d = new Date(e.date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  });

const requestIdentity = (request) => ({
  studentId: request.student?._id ?? request.student ?? undefined,
  userId: request.user?._id ?? request.user ?? undefined,
});

/**
 * Reject a second pending request for a day that already has one.
 * ponytail: find-then-insert, not a unique index — Attendance's (student, date) indexes are
 * shared with punch-in and cannot be made unique without touching that path. Two simultaneous
 * submits for the same day can still both land; approving both just rewrites the same row.
 */
const assertNoPendingOverlap = async (ownerFilter, dates) => {
  const existing = await BackdatedAttendanceRequest.find({
    ...ownerFilter,
    status: 'pending',
    'attendanceEntries.date': { $in: dates },
  }).select('attendanceEntries.date');

  const wanted = new Set(dates.map((d) => d.getTime()));
  const conflicts = [];
  for (const req of existing) {
    for (const entry of req.attendanceEntries) {
      if (wanted.has(entry.date.getTime())) conflicts.push(entry.date.toISOString().split('T')[0]);
    }
  }
  if (conflicts.length > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `You already have pending backdated attendance requests for: ${[...new Set(conflicts)].join(', ')}`
    );
  }
};

/**
 * Create a backdated attendance request for a student profile.
 * @param {ObjectId} studentId
 * @param {Array} attendanceEntries - [{ date, punchIn, punchOut?, timezone? }]
 * @param {string} [notes]
 * @param {Object} user - Current user (the student's own user, or a reviewer)
 */
const createBackdatedAttendanceRequest = async (studentId, attendanceEntries, notes, user) => {
  const student = await Student.findById(studentId).populate('user', 'email');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  if (!(await canReviewRequests(user)) && String(student.user?._id || student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only create backdated attendance requests for yourself');
  }

  const { entries, dates } = normalizeEntries(attendanceEntries);
  await assertDaysAreRequestable({ studentId, dates });
  await assertNoPendingOverlap({ student: studentId }, dates);

  const studentEmail = student.user?.email ?? student.email ?? '';
  const request = await BackdatedAttendanceRequest.create({
    student: studentId,
    studentEmail,
    attendanceEntries: entries,
    notes: notes || null,
    status: 'pending',
    requestedBy: user.id,
  });

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'student', select: 'user', populate: { path: 'user', select: 'name email' } },
    { path: 'requestedBy', select: 'name email' },
  ]);
  return request;
};

/**
 * Create a backdated attendance request for a user with no Student profile (agents).
 * @param {ObjectId} userId
 * @param {Array} attendanceEntries - [{ date, punchIn, punchOut?, timezone? }]
 * @param {string} [notes]
 * @param {Object} user - Current user (must be same as userId)
 */
const createBackdatedAttendanceRequestForUser = async (userId, attendanceEntries, notes, user) => {
  if (String(userId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only create backdated attendance requests for yourself');
  }

  const userDoc = await User.findById(userId).select('email').lean();
  if (!userDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const { entries, dates } = normalizeEntries(attendanceEntries);
  await assertDaysAreRequestable({ userId, dates });
  await assertNoPendingOverlap({ user: userId }, dates);

  const request = await BackdatedAttendanceRequest.create({
    user: userId,
    userEmail: userDoc.email || '',
    attendanceEntries: entries,
    notes: notes || null,
    status: 'pending',
    requestedBy: user.id,
  });

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'user', select: 'name email' },
    { path: 'requestedBy', select: 'name email' },
  ]);
  return request;
};

/**
 * Query backdated attendance requests (non-reviewer: only own student or user-based requests)
 */
const queryBackdatedAttendanceRequests = async (filter, options, user) => {
  if (!(await canReviewRequests(user))) {
    const students = await Student.find({ user: user.id }).select('_id');
    const studentIds = students.map((s) => s._id);
    const orConditions = [{ user: user.id }];
    if (studentIds.length > 0) orConditions.push({ student: { $in: studentIds } });
    if (filter.student != null && !filter.student.$in) {
      // specific student - ownership already checked by getBackdatedAttendanceRequestsByStudentId
    } else {
      filter.$or = orConditions;
    }
  }

  const requests = await BackdatedAttendanceRequest.paginate(filter, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
  });

  if (requests.results?.length > 0) {
    await BackdatedAttendanceRequest.populate(requests.results, [
      { path: 'student', select: 'user', populate: { path: 'user', select: 'name email' } },
      // User-based requests (agents with no Student) render as "Unknown" without this.
      { path: 'user', select: 'name email' },
      { path: 'requestedBy', select: 'name email' },
      { path: 'reviewedBy', select: 'name email' },
    ]);
  }

  return requests;
};

/**
 * Get backdated attendance request by ID.
 *
 * The response carries `dayConflicts`: days in this request that are a holiday, an existing
 * leave, or a week-off. Approving overwrites them, so the reviewer is shown what they are
 * about to replace before they confirm.
 */
const getBackdatedAttendanceRequestById = async (id, user) => {
  const request = await BackdatedAttendanceRequest.findById(id)
    .populate('student', 'user')
    .populate('user', 'name email')
    .populate('requestedBy', 'name email')
    .populate('reviewedBy', 'name email');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  const studentUserId = request.student?.user?._id ?? request.student?.user;
  const requestUserId = request.user?._id ?? request.user;
  const isOwner = String(studentUserId) === String(user.id) || String(requestUserId) === String(user.id);
  if (!(await canReviewRequests(user)) && !isOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const dayConflicts =
    request.status === 'pending'
      ? await findBlockedAttendanceDays({ ...requestIdentity(request), dates: requestDates(request) })
      : [];

  return { ...request.toJSON(), dayConflicts };
};

/** Create or update the single Attendance row one request entry maps to. */
const writeAttendanceForEntry = async (request, entry) => {
  const normalizedDate = new Date(entry.date);
  normalizedDate.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(normalizedDate);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const isUserBased = request.user != null;
  const owner = isUserBased
    ? { user: request.user?._id ?? request.user }
    : { student: request.student?._id ?? request.student };

  let attendance = await Attendance.findOne({ ...owner, date: { $gte: normalizedDate, $lt: nextDay } });
  if (!attendance) {
    attendance = new Attendance({ ...owner, date: normalizedDate });
    attendance.studentEmail = isUserBased ? request.userEmail || request.user?.email || '' : request.studentEmail;
    if (isUserBased && request.user?.name) attendance.studentName = request.user.name;
  }

  attendance.day = DAY_NAMES[normalizedDate.getUTCDay()];
  attendance.punchIn = entry.punchIn;
  attendance.punchOut = entry.punchOut || null;
  attendance.timezone = entry.timezone;
  attendance.notes = request.notes || '';
  attendance.duration = entry.punchOut ? entry.punchOut.getTime() - entry.punchIn.getTime() : 0;
  attendance.status = 'Present';
  attendance.isActive = true;
  await attendance.save();

  return isUserBased ? attendance : attendance.populate('student', 'user');
};

/**
 * Approve backdated attendance request and create/update Attendance records.
 *
 * Attendance is written BEFORE the status flips. The old order saved `approved` first and
 * swallowed per-entry failures, so a multi-day request could sit Approved with only some
 * days actually written and nothing to show which. Now a failure leaves the request pending.
 * ponytail: no transaction — a failure part-way can leave rows for the earlier days. Approving
 * again rewrites the same days, so a retry is safe and idempotent. Upgrade path if that stops
 * being good enough: a replica-set session around the loop.
 */
const approveBackdatedAttendanceRequest = async (requestId, adminComment, user) => {
  if (!(await canReviewRequests(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to approve backdated attendance requests');
  }

  const request = await BackdatedAttendanceRequest.findById(requestId)
    .populate('student', 'user')
    .populate('user', 'name email');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot approve backdated attendance request. Current status is: ${request.status}`
    );
  }

  await normalizeRequestIdentity(request);

  const attendances = [];
  for (const entry of request.attendanceEntries) {
    attendances.push(await writeAttendanceForEntry(request, entry));
  }

  request.status = 'approved';
  request.adminComment = adminComment || null;
  request.reviewedBy = user.id;
  request.reviewedAt = new Date();
  await request.save();

  const emailForNotify = request.user != null ? request.userEmail || request.user?.email : request.studentEmail;
  const { notifyByEmail, plainTextEmailBody } = await import('./notification.service.js');
  const approvedBdMsg = adminComment
    ? `Your request was approved. Comment: ${adminComment}`
    : 'Your backdated attendance request was approved.';
  notifyByEmail(emailForNotify, {
    type: 'leave',
    title: 'Backdated attendance request approved',
    message: approvedBdMsg,
    link: '/settings/attendance/backdated-attendance-requests',
    email: {
      subject: 'Backdated attendance request approved',
      text: plainTextEmailBody(approvedBdMsg, '/settings/attendance/backdated-attendance-requests'),
    },
  }).catch(() => {});

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'requestedBy', select: 'name email' },
    { path: 'reviewedBy', select: 'name email' },
  ]);
  return {
    success: true,
    message: `Backdated attendance request approved. ${attendances.length} attendance record(s) created/updated.`,
    data: { request, attendances },
  };
};

/**
 * Reject backdated attendance request
 */
const rejectBackdatedAttendanceRequest = async (requestId, adminComment, user) => {
  if (!(await canReviewRequests(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to reject backdated attendance requests');
  }

  const request = await BackdatedAttendanceRequest.findById(requestId);

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot reject backdated attendance request. Current status is: ${request.status}`
    );
  }

  await normalizeRequestIdentity(request);
  request.status = 'rejected';
  request.adminComment = adminComment || null;
  request.reviewedBy = user.id;
  request.reviewedAt = new Date();
  await request.save();

  const emailForNotify = request.user != null ? request.userEmail || '' : request.studentEmail;
  const { notifyByEmail, plainTextEmailBody } = await import('./notification.service.js');
  const rejectedBdMsg = adminComment
    ? `Your request was not approved. Comment: ${adminComment}`
    : 'Your backdated attendance request was rejected.';
  notifyByEmail(emailForNotify, {
    type: 'leave',
    title: 'Backdated attendance request rejected',
    message: rejectedBdMsg,
    link: '/settings/attendance/backdated-attendance-requests',
    email: {
      subject: 'Backdated attendance request rejected',
      text: plainTextEmailBody(rejectedBdMsg, '/settings/attendance/backdated-attendance-requests'),
    },
  }).catch(() => {});

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'student', select: 'user' },
    { path: 'user', select: 'name email' },
    { path: 'requestedBy', select: 'name email' },
    { path: 'reviewedBy', select: 'name email' },
  ]);
  return request;
};

/**
 * Update backdated attendance request (reviewer only, pending only).
 * Uses findByIdAndUpdate with $set so only attendanceEntries/notes are updated; required fields
 * (student, studentEmail) are never touched and validation does not re-check them.
 */
const updateBackdatedAttendanceRequest = async (requestId, updateData, user) => {
  if (!(await canReviewRequests(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to update backdated attendance requests');
  }

  const existing = await BackdatedAttendanceRequest.findById(requestId).select('status');
  if (!existing) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }
  if (existing.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot update backdated attendance request. Current status is: ${existing.status}`
    );
  }

  const updatePayload = {};

  if (updateData.attendanceEntries !== undefined) {
    updatePayload.attendanceEntries = normalizeEntries(updateData.attendanceEntries).entries;
  }

  if (updateData.notes !== undefined) {
    updatePayload.notes = updateData.notes || null;
  }

  const populatePaths = [
    { path: 'student', select: 'user' },
    { path: 'user', select: 'name email' },
    { path: 'requestedBy', select: 'name email' },
  ];

  if (Object.keys(updatePayload).length === 0) {
    return BackdatedAttendanceRequest.findById(requestId).populate(populatePaths);
  }

  return BackdatedAttendanceRequest.findByIdAndUpdate(
    requestId,
    { $set: updatePayload },
    { new: true, runValidators: true }
  ).populate(populatePaths);
};

/**
 * Cancel backdated attendance request (owner or reviewer)
 */
const cancelBackdatedAttendanceRequest = async (requestId, user) => {
  const request = await BackdatedAttendanceRequest.findById(requestId).populate('student', 'user');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  const studentUserId = request.student?.user?._id ?? request.student?.user;
  const requestUserId = request.user?._id ?? request.user;
  const isOwner = String(studentUserId) === String(user.id) || String(requestUserId) === String(user.id);
  if (!(await canReviewRequests(user)) && !isOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only cancel your own backdated attendance requests');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot cancel backdated attendance request. Current status is: ${request.status}`
    );
  }

  await normalizeRequestIdentity(request);
  request.status = 'cancelled';
  await request.save();

  await BackdatedAttendanceRequest.populate(request, [{ path: 'requestedBy', select: 'name email' }]);
  return request;
};

/**
 * Get backdated attendance requests by student ID
 */
const getBackdatedAttendanceRequestsByStudentId = async (studentId, options = {}, user) => {
  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  if (!(await canReviewRequests(user)) && String(student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const filter = { student: studentId };
  const queryOptions = pick(options, ['sortBy', 'limit', 'page', 'status']);
  if (options.status) filter.status = options.status;
  return queryBackdatedAttendanceRequests(filter, queryOptions, user);
};

/**
 * Get backdated attendance requests by user ID (for agents; no Student).
 */
const getBackdatedAttendanceRequestsByUserId = async (userId, options = {}, user) => {
  if (String(userId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const filter = { user: userId };
  const queryOptions = pick(options, ['sortBy', 'limit', 'page', 'status']);
  if (options.status) filter.status = options.status;
  return queryBackdatedAttendanceRequests(filter, queryOptions, user);
};

export {
  createBackdatedAttendanceRequest,
  createBackdatedAttendanceRequestForUser,
  queryBackdatedAttendanceRequests,
  getBackdatedAttendanceRequestById,
  approveBackdatedAttendanceRequest,
  rejectBackdatedAttendanceRequest,
  updateBackdatedAttendanceRequest,
  cancelBackdatedAttendanceRequest,
  getBackdatedAttendanceRequestsByStudentId,
  getBackdatedAttendanceRequestsByUserId,
  normalizeEntries,
  canReviewRequests,
};
