import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentCourseService from '../services/studentCourse.service.js';
import * as courseLearnerNoteService from '../services/courseLearnerNote.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

/**
 * Get student's courses
 */
const getStudentCourses = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const filter = pick(req.query, ['status', 'search', 'category', 'instructor', 'progress']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  
  // Check if student can view own courses or has permission
  const isAdmin = await userIsAdmin(req.user);
  if (!isAdmin) {
    // For students, only allow viewing their own courses.
    // TODO: verify studentId matches student's user id if stricter scoping is required.
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
  
  res.send(studentCourseService.toCourseProgressPayload(progress));
});

/**
 * Mark playlist item as incomplete
 */
const markItemIncomplete = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  const { playlistItemId } = req.body;

  if (!playlistItemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'playlistItemId is required');
  }

  const progress = await studentCourseService.markItemIncomplete(studentId, moduleId, playlistItemId);
  res.send(studentCourseService.toCourseProgressPayload(progress));
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
  
  res.send(studentCourseService.toCourseProgressPayload(progress));
});

/**
 * Get private learner note for a playlist item.
 */
const getCourseNote = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  const note = await courseLearnerNoteService.getNote(studentId, moduleId, playlistItemId);
  res.send(note);
});

/**
 * Upsert private learner note for a playlist item.
 */
const upsertCourseNote = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  const note = await courseLearnerNoteService.upsertNote(studentId, moduleId, playlistItemId, req.body.body);
  res.send(note);
});

export {
  getStudentCourses,
  getStudentCourse,
  startCourse,
  markItemComplete,
  markItemIncomplete,
  updateLastAccessed,
  getCourseNote,
  upsertCourseNote,
};
