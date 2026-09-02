import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import { MEETING_ALL_ACCESS } from '../../config/permissions.js';
import * as recordingValidation from '../../validations/recording.validation.js';
import * as recordingController from '../../controllers/recording.controller.js';

const router = express.Router();

/**
 * Read-only recordings access (list + transcript). VIEW tier: `meetings.read`, or the
 * separate `meetings.record` grant used by mentors/training. `meetings.manage` is NOT
 * accepted — it is a union of ANY write action, so a create-only role satisfied it and
 * reached this endpoint with no VIEW at all. What a caller then SEES is narrowed by
 * recordingScope, which is unrestricted only under MEETING_ALL_ACCESS.
 */
const canViewRecordings = [
  auth(),
  requireAnyOfPermissions('meetings.read', 'meetings.record'),
];

/**
 * LiveKit sync pulls every egress and upserts Recording rows tenant-wide, so it is gated
 * on the full admin-like tier (AND of all four) — the same condition that grants
 * unrestricted recording visibility. Was `meetings.manage`, which any single write action
 * satisfied, letting a create-only role trigger a company-wide sync.
 */
const canSyncRecordings = [auth(), requirePermissions(...MEETING_ALL_ACCESS)];

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
