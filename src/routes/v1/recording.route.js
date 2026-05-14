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

/**
 * POST /recordings/sync
 * Pull every egress from LiveKit + upsert Recording rows. Idempotent.
 * Use when DB is out of sync with LiveKit (missed webhooks, fresh deploy, etc.).
 */
router.post(
  '/sync',
  auth(),
  requirePermissions('meetings.record'),
  recordingController.syncFromLiveKit
);

/**
 * GET /recordings/:recordingId/transcript
 * Return transcript segments for a recording (sequenceNumber asc). Empty
 * `segments` array if AI pipeline hasn't run or produced no output.
 */
router
  .route('/:recordingId/transcript')
  .get(
    auth(),
    requirePermissions('meetings.record'),
    validate(recordingValidation.getTranscript),
    recordingController.getTranscript
  );

export default router;
