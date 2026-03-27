import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requireDesignatedSuperadmin from '../../middlewares/requireDesignatedSuperadmin.js';
import requireActivityLogsListAccess from '../../middlewares/requireActivityLogsListAccess.js';
import * as activityLogValidation from '../../validations/activityLog.validation.js';
import * as activityLogController from '../../controllers/activityLog.controller.js';

const router = express.Router();

router.get(
  '/export',
  auth(),
  requireDesignatedSuperadmin,
  validate(activityLogValidation.exportActivityLogs),
  activityLogController.exportActivityLogs
);

router.get(
  '/network-preview',
  auth(),
  requireActivityLogsListAccess,
  activityLogController.getActivityLogNetworkPreview
);

router
  .route('/')
  .get(
    auth(),
    requireActivityLogsListAccess,
    validate(activityLogValidation.getActivityLogs),
    activityLogController.getActivityLogs
  );

export default router;
