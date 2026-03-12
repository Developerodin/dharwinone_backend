import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as atsAnalyticsValidation from '../../validations/atsAnalytics.validation.js';
import atsAnalyticsController from '../../controllers/atsAnalytics.controller.js';

const router = express.Router();

router.get(
  '/',
  auth(),
  requirePermissions('ats.analytics'),
  validate(atsAnalyticsValidation.getAtsAnalytics),
  atsAnalyticsController.getAtsAnalytics
);

router.get(
  '/drill',
  auth(),
  requirePermissions('ats.analytics'),
  validate(atsAnalyticsValidation.drillDown),
  atsAnalyticsController.drillDown
);

router.get(
  '/applications-over-time-by-candidates',
  auth(),
  requirePermissions('ats.analytics'),
  validate(atsAnalyticsValidation.applicationsOverTimeByCandidates),
  atsAnalyticsController.applicationsOverTimeByCandidates
);

export default router;
