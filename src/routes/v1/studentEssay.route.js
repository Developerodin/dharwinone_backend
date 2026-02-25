import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as studentEssayValidation from '../../validations/studentEssay.validation.js';
import * as studentEssayController from '../../controllers/studentEssay.controller.js';

const router = express.Router();

router
  .route('/:studentId/courses/:moduleId/essays/:playlistItemId/submit')
  .post(
    auth(),
    requirePermissions('students.quizzes.take'),
    validate(studentEssayValidation.submitEssayAttempt),
    studentEssayController.submitEssayAttempt
  );

export default router;
