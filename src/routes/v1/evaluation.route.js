import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as evaluationController from '../../controllers/evaluation.controller.js';

const router = express.Router();

router.get(
  '/',
  auth(),
  requirePermissions('modules.read'),
  evaluationController.default.getEvaluation
);

export default router;
