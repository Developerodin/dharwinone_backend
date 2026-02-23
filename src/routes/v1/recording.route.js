import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as recordingValidation from '../../validations/recording.validation.js';
import * as recordingController from '../../controllers/recording.controller.js';

const router = express.Router();

/**
 * GET /recordings
 * List all meeting recordings (paginated). Requires auth + meetings.record permission.
 */
router
  .route('/')
  .get(
    auth(),
    requirePermissions('meetings.record'),
    validate(recordingValidation.listRecordings),
    recordingController.listAll
  );

export default router;
