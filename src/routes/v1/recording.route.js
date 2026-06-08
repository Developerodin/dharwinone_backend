import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as recordingValidation from '../../validations/recording.validation.js';
import * as recordingController from '../../controllers/recording.controller.js';

const router = express.Router();

/** Read-only recordings access (list + transcript). Sync stays on manage-tier below. */
const canViewRecordings = [
  auth(),
  requireAnyOfPermissions('meetings.read', 'meetings.manage', 'meetings.record'),
];

/** LiveKit sync mutates Recording rows — manage-tier only (not read/record-only roles). */
const canSyncRecordings = [auth(), requireAnyOfPermissions('meetings.manage')];

/**
 * GET /recordings
 * List all meeting recordings (paginated).
 */
router
  .route('/')
  .get(...canViewRecordings, validate(recordingValidation.listRecordings), recordingController.listAll);

/**
 * POST /recordings/sync
 * Pull every egress from LiveKit + upsert Recording rows. Idempotent.
 * Use when DB is out of sync with LiveKit (missed webhooks, fresh deploy, etc.).
 */
router.post('/sync', ...canSyncRecordings, recordingController.syncFromLiveKit);

/**
 * GET /recordings/:recordingId/transcript
 * Return transcript segments for a recording (sequenceNumber asc). Empty
 * `segments` array if AI pipeline hasn't run or produced no output.
 */
router
  .route('/:recordingId/transcript')
  .get(...canViewRecordings, validate(recordingValidation.getTranscript), recordingController.getTranscript);

export default router;
