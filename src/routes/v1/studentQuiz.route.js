import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as studentQuizValidation from '../../validations/studentQuiz.validation.js';
import * as studentQuizController from '../../controllers/studentQuiz.controller.js';

const router = express.Router();

// Get quiz (sanitized - no correct answers)
router
  .route('/:studentId/courses/:moduleId/quizzes/:playlistItemId')
  .get(
    auth(),
    requirePermissions('students.quizzes.take'),
    validate(studentQuizValidation.getQuiz),
    studentQuizController.getQuiz
  );

// Submit quiz attempt
router
  .route('/:studentId/courses/:moduleId/quizzes/:playlistItemId/submit')
  .post(
    auth(),
    requirePermissions('students.quizzes.take'),
    validate(studentQuizValidation.submitQuizAttempt),
    studentQuizController.submitQuizAttempt
  );

// Get quiz attempt history
router
  .route('/:studentId/courses/:moduleId/quizzes/:playlistItemId/attempts')
  .get(
    auth(),
    requirePermissions('students.courses.read'),
    validate(studentQuizValidation.getQuizAttemptHistory),
    studentQuizController.getQuizAttemptHistory
  );

// Get quiz results (with correct answers)
router
  .route('/:studentId/courses/:moduleId/quizzes/:playlistItemId/results')
  .get(
    auth(),
    requirePermissions('students.courses.read'),
    validate(studentQuizValidation.getQuizResults),
    studentQuizController.getQuizResults
  );

export default router;
