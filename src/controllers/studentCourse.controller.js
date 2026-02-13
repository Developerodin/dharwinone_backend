import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentCourseService from '../services/studentCourse.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Get student's courses
 */
const getStudentCourses = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const filter = pick(req.query, ['status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  
  // Check if student can view own courses or has permission
  if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
    // For students, only allow viewing their own courses
    const studentUserId = req.user.id;
    // TODO: Verify studentId matches student's user ID
    // For now, we'll allow if they have students.courses.read permission
  }
  
  const result = await studentCourseService.queryStudentCourses(studentId, filter, options);
  res.send(result);
});

/**
 * Get single student course with full details
 */
const getStudentCourse = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  
  const course = await studentCourseService.getStudentCourse(studentId, moduleId);
  res.send(course);
});

/**
 * Start course
 */
const startCourse = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  
  const progress = await studentCourseService.startCourse(studentId, moduleId);
  
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.STUDENT_COURSE_START,
    EntityTypes.STUDENT_COURSE_PROGRESS,
    progress.id,
    { moduleId, studentId },
    req
  );
  
  res.send(progress);
});

/**
 * Mark playlist item as complete
 */
const markItemComplete = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  const { playlistItemId, contentType } = req.body;
  
  if (!playlistItemId || !contentType) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'playlistItemId and contentType are required');
  }
  
  const progress = await studentCourseService.markItemComplete(
    studentId,
    moduleId,
    playlistItemId,
    contentType
  );
  
  res.send(progress);
});

/**
 * Update last accessed item
 */
const updateLastAccessed = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  const { playlistItemId } = req.body;
  
  if (!playlistItemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'playlistItemId is required');
  }
  
  const progress = await studentCourseService.updateLastAccessed(
    studentId,
    moduleId,
    playlistItemId
  );
  
  res.send(progress);
});

export {
  getStudentCourses,
  getStudentCourse,
  startCourse,
  markItemComplete,
  updateLastAccessed,
};
