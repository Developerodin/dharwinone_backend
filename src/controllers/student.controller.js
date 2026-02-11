import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentService from '../services/student.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getStudents = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await studentService.queryStudents(filter, options);
  res.send(result);
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

export {
  getStudents,
  getStudent,
  updateStudent,
  deleteStudent,
  uploadProfileImage,
  getProfileImage,
};
