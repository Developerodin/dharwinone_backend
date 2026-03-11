import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import BackdatedAttendanceRequest from '../models/backdatedAttendanceRequest.model.js';
import Student from '../models/student.model.js';
import Attendance from '../models/attendance.model.js';
import Role from '../models/role.model.js';
import pick from '../utils/pick.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Sync check: user.role indicates admin */
const isAdminByRole = (user) => user.role === 'admin' || user.role === 'Administrator';

/** Async: check if user is admin (role field OR has Administrator role via roleIds) */
const isAdminUser = async (user) => {
  if (isAdminByRole(user)) return true;
  const roleIds = user.roleIds || [];
  if (roleIds.length === 0) return false;
  const adminRole = await Role.findOne({ _id: { $in: roleIds }, name: 'Administrator', status: 'active' });
  return !!adminRole;
};

/**
 * Create a backdated attendance request
 * @param {ObjectId} studentId
 * @param {Array} attendanceEntries - [{ date, punchIn, punchOut?, timezone? }]
 * @param {string} [notes]
 * @param {Object} user - Current user (student's user or admin)
 */
const createBackdatedAttendanceRequest = async (studentId, attendanceEntries, notes, user) => {
  const student = await Student.findById(studentId).populate('user', 'email');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  if (!(await isAdminUser(user)) && String(student.user?._id || student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only create backdated attendance requests for yourself');
  }

  if (!Array.isArray(attendanceEntries) || attendanceEntries.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one attendance entry is required');
  }

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
  const normalizedEntries = [];
  const normalizedDates = new Set();

  for (let i = 0; i < attendanceEntries.length; i++) {
    const entry = attendanceEntries[i];
    if (!entry.date || !entry.punchIn || !entry.punchOut) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: date, punchIn, and punchOut are required`);
    }

    const dateObj = new Date(entry.date);
    if (isNaN(dateObj.getTime())) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid date: ${entry.date}`);
    }
    const utcYear = dateObj.getUTCFullYear();
    const utcMonth = dateObj.getUTCMonth();
    const utcDay = dateObj.getUTCDate();
    const normalizedDate = new Date(Date.UTC(utcYear, utcMonth, utcDay, 0, 0, 0, 0));

    if (normalizedDate >= todayUTC) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attendance entry ${i + 1}: Backdated attendance requests can only be made for past dates`
      );
    }

    const dateKey = normalizedDate.getTime();
    if (normalizedDates.has(dateKey)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attendance entry ${i + 1}: Duplicate date ${normalizedDate.toISOString().split('T')[0]} in the same request`
      );
    }
    normalizedDates.add(dateKey);

    let punchIn = new Date(entry.punchIn);
    if (isNaN(punchIn.getTime())) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchIn time: ${entry.punchIn}`);
    }
    const punchInDate = new Date(normalizedDate);
    punchInDate.setUTCHours(punchIn.getUTCHours(), punchIn.getUTCMinutes(), punchIn.getUTCSeconds(), punchIn.getUTCMilliseconds());
    punchIn = punchInDate;

    let punchOut = null;
    if (entry.punchOut) {
      punchOut = new Date(entry.punchOut);
      if (isNaN(punchOut.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchOut time: ${entry.punchOut}`);
      }
      const punchOutDate = new Date(normalizedDate);
      punchOutDate.setUTCHours(punchOut.getUTCHours(), punchOut.getUTCMinutes(), punchOut.getUTCSeconds(), punchOut.getUTCMilliseconds());
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
    }

    normalizedEntries.push({
      date: normalizedDate,
      punchIn,
      punchOut: punchOut || null,
      timezone: entry.timezone || 'UTC',
    });
  }

  const dateArray = Array.from(normalizedDates);
  const existingRequests = await BackdatedAttendanceRequest.find({
    student: studentId,
    status: 'pending',
    'attendanceEntries.date': { $in: dateArray },
  });

  if (existingRequests.length > 0) {
    const conflictingDates = [];
    for (const existingRequest of existingRequests) {
      for (const existingEntry of existingRequest.attendanceEntries) {
        const existingDateKey = existingEntry.date.getTime();
        if (normalizedDates.has(existingDateKey)) {
          conflictingDates.push(existingEntry.date.toISOString().split('T')[0]);
        }
      }
    }
    if (conflictingDates.length > 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `You already have pending backdated attendance requests for: ${conflictingDates.join(', ')}`
      );
    }
  }

  const studentEmail = student.user?.email ?? student.email ?? '';
  const request = await BackdatedAttendanceRequest.create({
    student: studentId,
    studentEmail,
    attendanceEntries: normalizedEntries,
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
 * Query backdated attendance requests (non-admin: only students owned by user)
 */
const queryBackdatedAttendanceRequests = async (filter, options, user) => {
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

  const requests = await BackdatedAttendanceRequest.paginate(filter, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
  });

  if (requests.results?.length > 0) {
    await BackdatedAttendanceRequest.populate(requests.results, [
      { path: 'student', select: 'user', populate: { path: 'user', select: 'name email' } },
      { path: 'requestedBy', select: 'name email' },
      { path: 'reviewedBy', select: 'name email' },
    ]);
  }

  return requests;
};

/**
 * Get backdated attendance request by ID
 */
const getBackdatedAttendanceRequestById = async (id, user) => {
  const request = await BackdatedAttendanceRequest.findById(id)
    .populate('student', 'user')
    .populate('requestedBy', 'name email')
    .populate('reviewedBy', 'name email');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  const studentUserId = request.student?.user?._id ?? request.student?.user;
  if (!(await isAdminUser(user)) && String(studentUserId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  return request;
};

/**
 * Approve backdated attendance request and create/update Attendance records
 */
const approveBackdatedAttendanceRequest = async (requestId, adminComment, user) => {
  if (!(await isAdminUser(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can approve backdated attendance requests');
  }

  const request = await BackdatedAttendanceRequest.findById(requestId).populate('student', 'user');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot approve backdated attendance request. Current status is: ${request.status}`
    );
  }

  request.status = 'approved';
  request.adminComment = adminComment || null;
  request.reviewedBy = user.id;
  request.reviewedAt = new Date();
  await request.save();

  const studentEmail = request.studentEmail;
  const studentId = request.student._id;
  const createdOrUpdatedAttendances = [];
  const errors = [];

  for (let i = 0; i < request.attendanceEntries.length; i++) {
    const entry = request.attendanceEntries[i];
    try {
      const normalizedDate = new Date(entry.date);
      normalizedDate.setUTCHours(0, 0, 0, 0);
      const nextDay = new Date(normalizedDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);

      let attendance = await Attendance.findOne({
        student: studentId,
        date: { $gte: normalizedDate, $lt: nextDay },
      });

      const day = DAY_NAMES[normalizedDate.getUTCDay()];
      const duration = entry.punchOut ? entry.punchOut.getTime() - entry.punchIn.getTime() : 0;

      if (attendance) {
        attendance.punchIn = entry.punchIn;
        attendance.punchOut = entry.punchOut || null;
        attendance.timezone = entry.timezone;
        attendance.notes = request.notes || '';
        attendance.duration = duration;
        attendance.status = 'Present';
        attendance.isActive = true;
        attendance.day = day;
        await attendance.save();
        createdOrUpdatedAttendances.push(await attendance.populate('student', 'user'));
      } else {
        attendance = await Attendance.create({
          student: studentId,
          studentEmail,
          date: normalizedDate,
          day,
          punchIn: entry.punchIn,
          punchOut: entry.punchOut || null,
          timezone: entry.timezone,
          notes: request.notes || '',
          duration,
          status: 'Present',
          isActive: true,
        });
        createdOrUpdatedAttendances.push(await attendance.populate('student', 'user'));
      }
    } catch (error) {
      errors.push({
        entryIndex: i,
        date: entry.date.toISOString().split('T')[0],
        error: error.message,
      });
    }
  }

  if (createdOrUpdatedAttendances.length === 0 && errors.length > 0) {
    request.status = 'pending';
    request.adminComment = null;
    request.reviewedBy = null;
    request.reviewedAt = null;
    await request.save();
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to create/update attendance for all dates: ${errors.map((e) => `${e.date}: ${e.error}`).join('; ')}`
    );
  }

  const { notifyByEmail } = await import('./notification.service.js');
  notifyByEmail(request.studentEmail, {
    type: 'leave',
    title: 'Backdated attendance request approved',
    message: adminComment ? `Your request was approved. Comment: ${adminComment}` : 'Your backdated attendance request was approved.',
    link: '/settings/attendance/backdated-attendance-requests',
  }).catch(() => {});

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'requestedBy', select: 'name email' },
    { path: 'reviewedBy', select: 'name email' },
  ]);
  return {
    success: true,
    message: `Backdated attendance request approved. ${createdOrUpdatedAttendances.length} attendance record(s) created/updated successfully${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
    data: {
      request,
      attendances: createdOrUpdatedAttendances,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
};

/**
 * Reject backdated attendance request
 */
const rejectBackdatedAttendanceRequest = async (requestId, adminComment, user) => {
  if (!(await isAdminUser(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can reject backdated attendance requests');
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

  request.status = 'rejected';
  request.adminComment = adminComment || null;
  request.reviewedBy = user.id;
  request.reviewedAt = new Date();
  await request.save();

  const { notifyByEmail } = await import('./notification.service.js');
  notifyByEmail(request.studentEmail, {
    type: 'leave',
    title: 'Backdated attendance request rejected',
    message: adminComment ? `Your request was not approved. Comment: ${adminComment}` : 'Your backdated attendance request was rejected.',
    link: '/settings/attendance/backdated-attendance-requests',
  }).catch(() => {});

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'student', select: 'user' },
    { path: 'requestedBy', select: 'name email' },
    { path: 'reviewedBy', select: 'name email' },
  ]);
  return request;
};

/**
 * Update backdated attendance request (admin only, pending only)
 */
const updateBackdatedAttendanceRequest = async (requestId, updateData, user) => {
  if (!(await isAdminUser(user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can update backdated attendance requests');
  }

  const request = await BackdatedAttendanceRequest.findById(requestId);

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot update backdated attendance request. Current status is: ${request.status}`
    );
  }

  if (updateData.attendanceEntries !== undefined) {
    if (!Array.isArray(updateData.attendanceEntries) || updateData.attendanceEntries.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'At least one attendance entry is required');
    }

    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
    const normalizedEntries = [];
    const normalizedDates = new Set();

    for (let i = 0; i < updateData.attendanceEntries.length; i++) {
      const entry = updateData.attendanceEntries[i];
      if (!entry.date || !entry.punchIn || !entry.punchOut) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: date, punchIn, and punchOut are required`);
      }

      const dateObj = new Date(entry.date);
      if (isNaN(dateObj.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid date: ${entry.date}`);
      }
      const utcYear = dateObj.getUTCFullYear();
      const utcMonth = dateObj.getUTCMonth();
      const utcDay = dateObj.getUTCDate();
      const normalizedDate = new Date(Date.UTC(utcYear, utcMonth, utcDay, 0, 0, 0, 0));

      if (normalizedDate >= todayUTC) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Attendance entry ${i + 1}: Backdated attendance requests can only be made for past dates`
        );
      }

      const dateKey = normalizedDate.getTime();
      if (normalizedDates.has(dateKey)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Attendance entry ${i + 1}: Duplicate date ${normalizedDate.toISOString().split('T')[0]} in the same request`
        );
      }
      normalizedDates.add(dateKey);

      let punchIn = new Date(entry.punchIn);
      if (isNaN(punchIn.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchIn time: ${entry.punchIn}`);
      }
      const punchInDate = new Date(normalizedDate);
      punchInDate.setUTCHours(punchIn.getUTCHours(), punchIn.getUTCMinutes(), punchIn.getUTCSeconds(), punchIn.getUTCMilliseconds());
      punchIn = punchInDate;

      let punchOut = null;
      if (entry.punchOut) {
        punchOut = new Date(entry.punchOut);
        if (isNaN(punchOut.getTime())) {
          throw new ApiError(httpStatus.BAD_REQUEST, `Attendance entry ${i + 1}: Invalid punchOut time: ${entry.punchOut}`);
        }
        const punchOutDate = new Date(normalizedDate);
        punchOutDate.setUTCHours(punchOut.getUTCHours(), punchOut.getUTCMinutes(), punchOut.getUTCSeconds(), punchOut.getUTCMilliseconds());
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
      }

      normalizedEntries.push({
        date: normalizedDate,
        punchIn,
        punchOut: punchOut || null,
        timezone: entry.timezone || 'UTC',
      });
    }

    request.attendanceEntries = normalizedEntries;
  }

  if (updateData.notes !== undefined) {
    request.notes = updateData.notes || null;
  }

  await request.save();

  await BackdatedAttendanceRequest.populate(request, [
    { path: 'student', select: 'user' },
    { path: 'requestedBy', select: 'name email' },
  ]);
  return request;
};

/**
 * Cancel backdated attendance request (student's user or admin)
 */
const cancelBackdatedAttendanceRequest = async (requestId, user) => {
  const request = await BackdatedAttendanceRequest.findById(requestId).populate('student', 'user');

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Backdated attendance request not found');
  }

  const studentUserId = request.student?.user?._id ?? request.student?.user;
  if (!(await isAdminUser(user)) && String(studentUserId) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only cancel your own backdated attendance requests');
  }

  if (request.status !== 'pending') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot cancel backdated attendance request. Current status is: ${request.status}`
    );
  }

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

  if (!(await isAdminUser(user)) && String(student.user) !== String(user.id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const filter = { student: studentId };
  const queryOptions = pick(options, ['sortBy', 'limit', 'page', 'status']);
  if (options.status) filter.status = options.status;
  return queryBackdatedAttendanceRequests(filter, queryOptions, user);
};

export {
  createBackdatedAttendanceRequest,
  queryBackdatedAttendanceRequests,
  getBackdatedAttendanceRequestById,
  approveBackdatedAttendanceRequest,
  rejectBackdatedAttendanceRequest,
  updateBackdatedAttendanceRequest,
  cancelBackdatedAttendanceRequest,
  getBackdatedAttendanceRequestsByStudentId,
};
