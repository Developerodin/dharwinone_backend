import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as analyticsController from '../../controllers/analytics.controller.js';

const router = express.Router();

router.get(
  '/',
  auth(),
  requirePermissions('training.analytics'),
  analyticsController.default.getTrainingAnalytics
);

export default router;
