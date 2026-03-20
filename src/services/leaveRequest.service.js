import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import LeaveRequest from '../models/leaveRequest.model.js';
import Student from '../models/student.model.js';
import Role from '../models/role.model.js';
import attendanceService from './attendance.service.js';
import pick from '../utils/pick.js';
import { userIsAdminOrAgent } from '../utils/roleHelpers.js';

/** Async: user can manage leave requests (Administrator or Agent via roleIds) */
const isAdminUser = async (user) => {
  return userIsAdminOrAgent(user);
};

/**
 * Create a leave request
 * @param {ObjectId} studentId
 * @param {Array<Date>} dates - Array of dates for leave
 * @param {string} leaveType - Type of leave ('casual', 'sick', or 'unpaid')
 * @param {string} [notes] - Optional notes
 * @param {Object} user - Current user (must be student's user or admin)
 * @returns {Promise<LeaveRequest>}
 */
const createLeaveRequest = async (studentId, dates, leaveType, notes, user) => {
  const student = await Student.findById(studentId).populate('user', 'email');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  if (!(await isAdminUser(user)) && String(student.user?._id || student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only create leave requests for yourself');
  }

  if (!Array.isArray(dates) || dates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one date is required');
  }

  if (!['casual', 'sick', 'unpaid'].includes(leaveType)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Leave type must be either "casual", "sick", or "unpaid"');
  }

  const normalizedDates = dates
    .map((d) => {
      const date = new Date(d);
      if (isNaN(date.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Invalid date: ${d}`);
      }
      const utcYear = date.getUTCFullYear();
      const utcMonth = date.getUTCMonth();
      const utcDay = date.getUTCDate();
      return new Date(Date.UTC(utcYear, utcMonth, utcDay, 0, 0, 0, 0));
    })
    .filter((date, index, self) => index === self.findIndex((d) => d.getTime() === date.getTime()))
    .sort((a, b) => a - b);

  const existingRequests = await LeaveRequest.find({
    student: studentId,
    status: 'pending',
    dates: { $in: normalizedDates },
  });

  if (existingRequests.length > 0) {
    const conflictingDates = existingRequests.flatMap((req) => req.dates);
    const duplicateDates = normalizedDates.filter((date) =>
      conflictingDates.some((existingDate) => existingDate.getTime() === date.getTime())
    );
    if (duplicateDates.length > 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `You already have pending leave requests for: ${duplicateDates.map((d) => d.toISOString().split('T')[0]).join(', ')}`
      );
    }
  }

  const studentEmail = student.user?.email ?? student.email ?? '';
  const leaveRequest = await LeaveRequest.create({
    student: studentId,
    studentEmail,
    dates: normalizedDates,
    leaveType,
    notes: notes || null,
    status: 'pending',
    requestedBy: user.id,
  });

  return leaveRequest.populate([{ path: 'student', select: 'user' }, { path: 'requestedBy', select: 'name email' }]);
};

/**
 * Query leave requests (non-admin: only students owned by user)
 */
const queryLeaveRequests = async (filter, options, user) => {
  if (!(await isAdminUser(user))) {
    const students = await Student.find({ user: user.id }).select('_id');
    const studentIds = students.map((s) => s._id);
    if (studentIds.length === 0) {
      return {
        results: [],
        page: options.page || 1,
        limit: options.limit || 10,
        totalPages: 0,
        totalResults: 0,
      };
    }
    filter.student = { $in: studentIds };
  }

  const leaveRequests = await LeaveRequest.paginate(filter, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'student', select: 'user', populate: { path: 'user', select: 'name email' } },
      { path: 'requestedBy', select: 'name email' },
      { path: 'reviewedBy', select: 'name email' },
    ],
  });

  return leaveRequests;
};

/**
 * Get leave request by ID
 */
const getLeaveRequestById = async (id, user) => {
  const leaveRequest = await LeaveRequest.findById(id)
    .populate('student', 'user')
    .populate('requestedBy', 'name email')
    .populate('reviewedBy', 'name email');
  if (leaveRequest?.student) {
    await leaveRequest.populate({ path: 'student.user', select: 'name email' });
  }

  if (!leaveRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Leave request not found');
  }

  const studentUserId = leaveRequest.student?.user?._id || leaveRequest.student?.user;
  if (!(await isAdminUser(user)) && String(studentUserId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  return leaveRequest;
};

/**
 * Approve leave request and assign leave via attendance service
 */
const approveLeaveRequest = async (requestId, adminComment, user) => {
  if (!(await isAdminUser(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can approve leave requests');
  }

  const leaveRequest = await LeaveRequest.findById(requestId).populate('student', 'user');

  if (!leaveRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Leave request not found');
  }

  if (leaveRequest.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot approve leave request. Current status is: ${leaveRequest.status}`
    );
  }

  leaveRequest.status = 'approved';
  leaveRequest.adminComment = adminComment || null;
  leaveRequest.reviewedBy = user.id;
  leaveRequest.reviewedAt = new Date();
  await leaveRequest.save();

  try {
    const assignResult = await attendanceService.assignLeavesToStudents(
      [leaveRequest.student._id],
      leaveRequest.dates,
      leaveRequest.leaveType,
      leaveRequest.notes || 'Approved leave request',
      user
    );

    const { notifyByEmail } = await import('./notification.service.js');
    notifyByEmail(leaveRequest.studentEmail, {
      type: 'leave',
      title: 'Leave request approved',
      message: adminComment ? `Your leave request has been approved. Comment: ${adminComment}` : 'Your leave request has been approved.',
      link: '/settings/attendance/leave-requests',
    }).catch(() => {});

    return {
      success: true,
      message: 'Leave request approved and leave assigned successfully',
      data: {
        leaveRequest: await leaveRequest.populate([{ path: 'requestedBy', select: 'name email' }, { path: 'reviewedBy', select: 'name email' }]),
        leaveAssignment: assignResult,
      },
    };
  } catch (error) {
    leaveRequest.status = 'pending';
    leaveRequest.adminComment = null;
    leaveRequest.reviewedBy = null;
    leaveRequest.reviewedAt = null;
    await leaveRequest.save();
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to assign leave: ${error.message}`);
  }
};

/**
 * Reject leave request
 */
const rejectLeaveRequest = async (requestId, adminComment, user) => {
  if (!(await isAdminUser(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can reject leave requests');
  }

  const leaveRequest = await LeaveRequest.findById(requestId);

  if (!leaveRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Leave request not found');
  }

  if (leaveRequest.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot reject leave request. Current status is: ${leaveRequest.status}`
    );
  }

  leaveRequest.status = 'rejected';
  leaveRequest.adminComment = adminComment || null;
  leaveRequest.reviewedBy = user.id;
  leaveRequest.reviewedAt = new Date();
  await leaveRequest.save();

  const { notifyByEmail } = await import('./notification.service.js');
  notifyByEmail(leaveRequest.studentEmail, {
    type: 'leave',
    title: 'Leave request rejected',
    message: adminComment ? `Your leave request was not approved. Comment: ${adminComment}` : 'Your leave request was not approved.',
    link: '/settings/attendance/leave-requests',
  }).catch(() => {});

  return leaveRequest.populate([
    { path: 'student', select: 'user' },
    { path: 'requestedBy', select: 'name email' },
    { path: 'reviewedBy', select: 'name email' },
  ]);
};

/**
 * Cancel leave request (student's user or admin)
 */
const cancelLeaveRequest = async (requestId, user) => {
  const leaveRequest = await LeaveRequest.findById(requestId).populate('student', 'user');

  if (!leaveRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Leave request not found');
  }

  const studentUserId = leaveRequest.student?.user?._id ?? leaveRequest.student?.user;
  if (!(await isAdminUser(user)) && String(studentUserId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only cancel your own leave requests');
  }

  if (leaveRequest.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot cancel leave request. Current status is: ${leaveRequest.status}`
    );
  }

  // Update only status so we don't re-run full document validation (avoids errors when
  // required fields like studentEmail are missing on legacy docs or altered by populate)
  const updated = await LeaveRequest.findByIdAndUpdate(
    requestId,
    { status: 'cancelled' },
    { new: true, runValidators: false }
  );

  return updated.populate([
    { path: 'student', select: 'user' },
    { path: 'requestedBy', select: 'name email' },
  ]);
};

/**
 * Get leave requests by student ID
 */
const getLeaveRequestsByStudentId = async (studentId, options = {}, user) => {
  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  if (!(await isAdminUser(user)) && String(student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const filter = { student: studentId };
  const queryOptions = pick(options, ['sortBy', 'limit', 'page', 'status']);
  if (options.status) filter.status = options.status;
  return queryLeaveRequests(filter, queryOptions, user);
};

export {
  createLeaveRequest,
  queryLeaveRequests,
  getLeaveRequestById,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  getLeaveRequestsByStudentId,
};
