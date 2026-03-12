import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import attendanceService from '../services/attendance.service.js';
import * as studentService from '../services/student.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import Student from '../models/student.model.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Get current user's student profile for attendance (punch in/out).
 * Auto-creates Student for Candidate, Agent, and other non-admin roles who don't have one.
 * Admins return 404 (they manage others' attendance, not their own).
 */
const getMyStudentForAttendance = catchAsync(async (req, res) => {
  const student = await studentService.getOrCreateStudentForAttendance(req.user);
  if (!student) {
    return res.status(httpStatus.NOT_FOUND).send({
      success: false,
      message: 'Admins do not fill attendance for themselves. Use Track Attendance to manage others.',
    });
  }
  res.send(student);
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

const getStudentAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.listByStudent(req.params.studentId, req.query);
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
  getStatus,
  getStudentAttendance,
  getStatistics,
  getTrackList,
  getTrackHistory,
  addHolidays,
  removeHolidays,
  assignLeave,
  regularize,
};
