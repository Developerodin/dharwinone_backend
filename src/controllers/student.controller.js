import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentService from '../services/student.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { getPresignedUploadUrl } from '../services/upload.service.js';

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

/**
 * Generate a presigned S3 upload URL for a student's profile image.
 * The frontend should:
 * 1) Use the returned URL to PUT the image to S3
 * 2) Save the returned key back to the student via PATCH as profileImageUrl, if desired
 */
const getStudentProfileImageUploadUrl = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const { fileName, contentType } = req.body;

  // Ensure the student exists
  const student = await studentService.getStudentById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const result = await getPresignedUploadUrl({
    fileName,
    contentType,
    userId: student.user?.id || student.user,
    folder: 'profile-images',
  });

  res.send(result);
});

export {
  getStudents,
  getStudent,
  updateStudent,
  getStudentProfileImageUploadUrl,
  deleteStudent,
};
