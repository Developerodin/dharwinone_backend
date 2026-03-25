import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentService from '../services/student.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getStudents = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'position', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await studentService.queryStudents(filter, options);
  res.send(result);
});

/**
 * Get the current user's student profile (for use with student courses API).
 * Returns 404 if the user has no linked student record.
 */
const getMyProfile = catchAsync(async (req, res) => {
  const student = await studentService.getStudentByUserId(req.user.id);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student profile not found for this user');
  }
  res.send(student);
});

const getStudent = catchAsync(async (req, res) => {
  const student = await studentService.getStudentById(req.params.studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  res.send(student);
});

const updateStudent = catchAsync(async (req, res) => {
  const student = await studentService.updateStudentById(req.params.studentId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.STUDENT_UPDATE,
    EntityTypes.STUDENT,
    student.id,
    {},
    req
  );
  res.send(student);
});

const deleteStudent = catchAsync(async (req, res) => {
  await studentService.deleteStudentById(req.params.studentId);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.STUDENT_DELETE,
    EntityTypes.STUDENT,
    req.params.studentId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

const uploadProfileImage = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No file provided');
  }

  const student = await studentService.updateStudentProfileImage(req.params.studentId, req.file, req.user);
  res.status(httpStatus.OK).send(student);
});

const getProfileImage = catchAsync(async (req, res) => {
  const data = await studentService.getStudentProfileImageUrl(req.params.studentId);

  // If client explicitly wants JSON (e.g., for frontend), return JSON
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(httpStatus.OK).send({
      success: true,
      data,
    });
  }

  // Default: redirect to presigned URL for direct preview/download
  return res.redirect(data.url);
});

/**
 * Create a student profile for an existing user who has the Student role.
 * That user will then appear in course assignment dropdowns.
 */
const createStudentFromUser = catchAsync(async (req, res) => {
  const student = await studentService.createStudentFromUser(req.body.userId, {
    ensureStudentRoleForCandidateOwner: Boolean(req.body.ensureStudentRoleForCandidateOwner),
  });
  res.status(httpStatus.CREATED).send(student);
});

/**
 * List users with Student role who do not yet have a Training student profile.
 * These users do not appear in course assignment until a profile is created.
 */
const getUsersWithoutStudentProfile = catchAsync(async (req, res) => {
  const users = await studentService.getUsersWithStudentRoleWithoutProfile();
  res.send({ results: users });
});

/**
 * Update week-off calendar for multiple students (admin/manage only)
 */
const updateWeekOff = catchAsync(async (req, res) => {
  const { studentIds, weekOff } = req.body;
  const result = await studentService.updateWeekOffForStudents(studentIds, weekOff, req.user);
  res.status(httpStatus.OK).send(result);
});

/**
 * Bulk import week-off by candidate email (e.g. from Excel)
 */
const importWeekOff = catchAsync(async (req, res) => {
  const { entries } = req.body;
  const result = await studentService.importWeekOffByEmail(entries, req.user);
  res.status(httpStatus.OK).send(result);
});

/**
 * Get week-off days for a student
 */
const getWeekOff = catchAsync(async (req, res) => {
  const result = await studentService.getStudentWeekOff(req.params.studentId);
  res.send(result);
});

/**
 * Assign shift to multiple students
 */
const assignShift = catchAsync(async (req, res) => {
  const { studentIds, shiftId } = req.body;
  const result = await studentService.assignShiftToStudents(studentIds, shiftId, req.user);
  res.status(httpStatus.OK).send(result);
});

export {
  getStudents,
  getStudent,
  getMyProfile,
  updateStudent,
  deleteStudent,
  uploadProfileImage,
  getProfileImage,
  createStudentFromUser,
  getUsersWithoutStudentProfile,
  updateWeekOff,
  importWeekOff,
  getWeekOff,
  assignShift,
};
