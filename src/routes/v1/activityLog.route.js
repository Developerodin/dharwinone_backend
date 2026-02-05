import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requireAdministratorRole from '../../middlewares/requireAdministratorRole.js';
import * as activityLogValidation from '../../validations/activityLog.validation.js';
import * as activityLogController from '../../controllers/activityLog.controller.js';

const router = express.Router();

router
  .route('/')
  .get(auth(), requireAdministratorRole(), validate(activityLogValidation.getActivityLogs), activityLogController.getActivityLogs);

export default router;
