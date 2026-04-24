import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import attendanceService from '../services/attendance.service.js';
import * as studentService from '../services/student.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Get current user's attendance identity (student or user).
 * Students/Candidates: return Student (type: 'student'), creating one if needed.
 * Agents without a Student: return user identity only (type: 'user') — no Student created.
 * Admins: 404.
 */
const getMyStudentForAttendance = catchAsync(async (req, res) => {
  const identity = await studentService.getAttendanceIdentity(req.user);
  if (!identity) {
    return res.status(httpStatus.NOT_FOUND).send({
      success: false,
      message: 'Admins do not fill attendance for themselves. Use Track Attendance to manage others.',
    });
  }
  if (identity.type === 'user') {
    return res.send(identity);
  }
  const out = identity.toJSON ? identity.toJSON() : (identity.toObject ? identity.toObject() : identity);
  if (typeof out === 'object' && out !== null) out.type = 'student';
  res.send(out);
});

const punchIn = catchAsync(async (req, res) => {
  const record = await attendanceService.punchIn(req.params.studentId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.ATTENDANCE_PUNCH_IN,
    EntityTypes.ATTENDANCE,
    record.id || record._id?.toString?.(),
    { studentId: req.params.studentId, punchIn: record.punchIn },
    req
  );
  res.status(httpStatus.OK).send({ success: true, data: record });
});

const punchOut = catchAsync(async (req, res) => {
  const record = await attendanceService.punchOut(req.params.studentId, req.body);
  const student = await Student.findById(req.params.studentId).select('user').lean();
  const isAdminPunchOut = student?.user?.toString?.() !== req.user?.id;
  await activityLogService.createActivityLog(
    req.user.id,
    isAdminPunchOut ? ActivityActions.ATTENDANCE_PUNCH_OUT_BY_ADMIN : ActivityActions.ATTENDANCE_PUNCH_OUT,
    EntityTypes.ATTENDANCE,
    record.id || record._id?.toString?.(),
    { studentId: req.params.studentId, punchOut: record.punchOut, performedBy: isAdminPunchOut ? 'admin' : 'self' },
    req
  );
  res.status(httpStatus.OK).send({ success: true, data: record });
});

const getStatus = catchAsync(async (req, res) => {
  const result = await attendanceService.getCurrentPunchStatus(req.params.studentId);
  res.send({ success: true, ...result });
});

/** Ensure current user is allowed to use /me routes (Agent without Student). Returns 403 otherwise. */
const requireMeIdentity = async (req) => {
  const identity = await studentService.getAttendanceIdentity(req.user);
  return identity && identity.type === 'user';
};

const punchInMe = catchAsync(async (req, res) => {
  const allowed = await requireMeIdentity(req);
  if (!allowed) {
    return res.status(httpStatus.FORBIDDEN).send({
      success: false,
      message: 'This endpoint is only for agents using user-based attendance. Use punch-in with your student ID if you have a student profile.',
    });
  }
  const userId = req.user.id || req.user._id?.toString?.();
  const record = await attendanceService.punchInByUser(userId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.ATTENDANCE_PUNCH_IN,
    EntityTypes.ATTENDANCE,
    record.id || record._id?.toString?.(),
    { userId, punchIn: record.punchIn },
    req
  );
  res.status(httpStatus.OK).send({ success: true, data: record });
});

const punchOutMe = catchAsync(async (req, res) => {
  const allowed = await requireMeIdentity(req);
  if (!allowed) {
    return res.status(httpStatus.FORBIDDEN).send({
      success: false,
      message: 'This endpoint is only for agents using user-based attendance. Use punch-out with your student ID if you have a student profile.',
    });
  }
  const userId = req.user.id || req.user._id?.toString?.();
  const record = await attendanceService.punchOutByUser(userId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.ATTENDANCE_PUNCH_OUT,
    EntityTypes.ATTENDANCE,
    record.id || record._id?.toString?.(),
    { userId, punchOut: record.punchOut, performedBy: 'self' },
    req
  );
  res.status(httpStatus.OK).send({ success: true, data: record });
});

const getStatusMe = catchAsync(async (req, res) => {
  const allowed = await requireMeIdentity(req);
  if (!allowed) {
    return res.status(httpStatus.FORBIDDEN).send({
      success: false,
      message: 'This endpoint is only for agents using user-based attendance.',
    });
  }
  const userId = req.user.id || req.user._id?.toString?.();
  const result = await attendanceService.getCurrentPunchStatusByUser(userId);
  res.send({ success: true, ...result });
});

const getStudentAttendanceMe = catchAsync(async (req, res) => {
  const allowed = await requireMeIdentity(req);
  if (!allowed) {
    return res.status(httpStatus.FORBIDDEN).send({
      success: false,
      message: 'This endpoint is only for agents using user-based attendance.',
    });
  }
  const userId = req.user.id || req.user._id?.toString?.();
  const result = await attendanceService.listByUser(userId, req.query);
  res.send(result);
});

const getStatisticsMe = catchAsync(async (req, res) => {
  const allowed = await requireMeIdentity(req);
  if (!allowed) {
    return res.status(httpStatus.FORBIDDEN).send({
      success: false,
      message: 'This endpoint is only for agents using user-based attendance.',
    });
  }
  const userId = req.user.id || req.user._id?.toString?.();
  const result = await attendanceService.getStatisticsByUser(userId, req.query);
  res.send(result);
});

const getStudentAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.listByStudent(req.params.studentId, req.query);
  res.send(result);
});

/** User-based attendance (Attendance.user) — e.g. agents without a Student profile */
const getUserAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.listByUser(req.params.userId, req.query);
  res.send(result);
});

/** List attendance for a candidate: uses Student records when present, otherwise user-based Attendance.user */
const getAttendanceByCandidate = catchAsync(async (req, res) => {
  const candidate = await Employee.findById(req.params.candidateId).select('owner').lean();
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  const ownerId = candidate.owner?.toString?.();
  if (!ownerId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Candidate has no owner');
  }
  const student = await Student.findOne({ user: ownerId }).select('_id').lean();
  if (student?._id) {
    const result = await attendanceService.listByStudent(student._id.toString(), req.query);
    return res.send(result);
  }
  const result = await attendanceService.listByUser(ownerId, req.query);
  res.send(result);
});

const getStatistics = catchAsync(async (req, res) => {
  const result = await attendanceService.getStatistics(req.params.studentId, req.query);
  res.send(result);
});

const getTrackList = catchAsync(async (req, res) => {
  const { search } = req.query;
  const result = await attendanceService.getTrackList({ search });
  res.send(result);
});

const getTrackHistory = catchAsync(async (req, res) => {
  const { search, ...rest } = req.query;
  const result = await attendanceService.getTrackHistory({ ...rest, search });
  res.send(result);
});

const addHolidays = catchAsync(async (req, res) => {
  const { studentIds, holidayIds } = req.body;
  const result = await attendanceService.addHolidaysToStudents(studentIds, holidayIds, req.user);
  res.status(httpStatus.OK).send({ success: true, ...result });
});

const removeHolidays = catchAsync(async (req, res) => {
  const { studentIds, holidayIds } = req.body;
  const result = await attendanceService.removeHolidaysFromStudents(studentIds, holidayIds, req.user);
  res.status(httpStatus.OK).send({ success: true, ...result });
});

const assignLeave = catchAsync(async (req, res) => {
  const { studentIds, dates, leaveType, notes } = req.body;
  const result = await attendanceService.assignLeavesToStudents(
    studentIds,
    dates,
    leaveType,
    notes || '',
    req.user
  );
  res.status(httpStatus.OK).send({ success: true, ...result });
});

const regularize = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const { attendanceEntries } = req.body;
  const result = await attendanceService.regularizeAttendance(studentId, attendanceEntries, req.user);
  res.status(httpStatus.OK).send({ success: true, message: `Regularized ${result.createdOrUpdated} attendance record(s).`, ...result });
});

export default {
  getMyStudentForAttendance,
  punchIn,
  punchOut,
  punchInMe,
  punchOutMe,
  getStatus,
  getStatusMe,
  getStudentAttendance,
  getUserAttendance,
  getAttendanceByCandidate,
  getStudentAttendanceMe,
  getStatistics,
  getStatisticsMe,
  getTrackList,
  getTrackHistory,
  addHolidays,
  removeHolidays,
  assignLeave,
  regularize,
};
