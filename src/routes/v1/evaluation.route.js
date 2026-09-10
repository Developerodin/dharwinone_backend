import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as evaluationController from '../../controllers/evaluation.controller.js';
import * as evaluationEssayValidation from '../../validations/evaluationEssay.validation.js';
import * as evaluationQuizValidation from '../../validations/evaluationQuiz.validation.js';

const router = express.Router();

router.get(
  '/',
  auth(),
  requirePermissions('evaluation.read'),
  evaluationController.default.getEvaluation
);

router.get(
  '/export',
  auth(),
  requirePermissions('evaluation.read'),
  evaluationController.default.exportEvaluationExcel
);

router.get(
  '/students/:studentId/courses/:moduleId/essay-attempts',
  auth(),
  requirePermissions('evaluation.read'),
  validate(evaluationEssayValidation.listStudentEssayAttempts),
  evaluationController.default.listStudentEssayAttempts
);

router.patch(
  '/essay-attempts/:attemptId',
  auth(),
  requirePermissions('evaluation.manage'),
  validate(evaluationEssayValidation.gradeEssayAttempt),
  evaluationController.default.gradeEssayAttempt
);

router.get(
  '/students/:studentId/courses/:moduleId/quiz-attempts',
  auth(),
  requirePermissions('evaluation.read'),
  validate(evaluationQuizValidation.listStudentQuizAttempts),
  evaluationController.default.listStudentQuizAttempts
);

router.patch(
  '/quiz-attempts/:attemptId',
  auth(),
  requirePermissions('evaluation.manage'),
  validate(evaluationQuizValidation.gradeQuizAttempt),
  evaluationController.default.gradeQuizAttempt
);

export default router;
