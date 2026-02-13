import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentQuizService from '../services/studentQuiz.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Get quiz (sanitized - no correct answers)
 */
const getQuiz = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  
  const quiz = await studentQuizService.getQuiz(studentId, moduleId, playlistItemId);
  res.send(quiz);
});

/**
 * Submit quiz attempt
 */
const submitQuizAttempt = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  const { answers, timeSpent } = req.body;
  
  if (!answers || !Array.isArray(answers)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'answers array is required');
  }
  
  const attempt = await studentQuizService.submitQuizAttempt(
    studentId,
    moduleId,
    playlistItemId,
    { answers, timeSpent }
  );
  
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.STUDENT_QUIZ_ATTEMPT,
    EntityTypes.STUDENT_QUIZ_ATTEMPT,
    attempt.id,
    { moduleId, studentId, playlistItemId, score: attempt.score.percentage },
    req
  );
  
  res.send(attempt);
});

/**
 * Get quiz attempt history
 */
const getQuizAttemptHistory = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  
  const attempts = await studentQuizService.getQuizAttemptHistory(
    studentId,
    moduleId,
    playlistItemId
  );
  res.send(attempts);
});

/**
 * Get quiz results (with correct answers shown)
 */
const getQuizResults = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  
  const results = await studentQuizService.getQuizResults(
    studentId,
    moduleId,
    playlistItemId
  );
  res.send(results);
});

export {
  getQuiz,
  submitQuizAttempt,
  getQuizAttemptHistory,
  getQuizResults,
};
