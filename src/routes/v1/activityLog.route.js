import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as activityLogValidation from '../../validations/activityLog.validation.js';
import * as activityLogController from '../../controllers/activityLog.controller.js';

const router = express.Router();

router
  .route('/')
  .get(
    auth(),
    requirePermissions('activityLogs.read'),
    validate(activityLogValidation.getActivityLogs),
    activityLogController.getActivityLogs
  );

export default router;
