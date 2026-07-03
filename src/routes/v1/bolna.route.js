import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import {
  requireAnyOfPermissionsOrAdministrator,
  requirePermissionOrAdministrator,
} from '../../middlewares/requirePermissionOrAdministrator.js';
import * as bolnaValidation from '../../validations/bolna.validation.js';
import * as bolnaController from '../../controllers/bolna.controller.js';
import * as bolnaCandidateAgentSettingsController from '../../controllers/bolnaCandidateAgentSettings.controller.js';

const router = express.Router();

router
  .route('/candidate-agent-settings')
  .get(
    auth(),
    requireAnyOfPermissionsOrAdministrator('bolna-voice-agent.read', 'bolna-voice-agent.manage'),
    bolnaCandidateAgentSettingsController.getBolnaCandidateAgentSettings
  )
  .patch(
    auth(),
    requirePermissionOrAdministrator('bolna-voice-agent.manage'),
    validate(bolnaValidation.patchBolnaCandidateAgentSettings),
    bolnaCandidateAgentSettingsController.patchBolnaCandidateAgentSettings
  );

// AI verification extraction setup — gated by the Call AI Features role toggle.
router
  .route('/candidate-agent/setup-extractions')
  .post(auth(), requirePermissions('call-ai.manage'), bolnaController.setupCandidateVerificationExtractions);

router
  .route('/diagnostics')
  .get(auth(), requirePermissionOrAdministrator('calls.view'), bolnaController.getBolnaDiagnostics);

router
  .route('/call')
  .post(auth(), requirePermissions('calls.create'), validate(bolnaValidation.initiateCall), bolnaController.initiateCall);

router
  .route('/candidate-call')
  .post(auth(), requirePermissions('calls.create'), validate(bolnaValidation.initiateCandidateCall), bolnaController.initiateCandidateCall);

router
  .route('/call-status/:executionId')
  .get(auth(), requirePermissions('calls.view'), validate(bolnaValidation.getCallStatus), bolnaController.getCallStatus);

router
  .route('/call-records')
  .get(auth(), requirePermissions('calls.view'), validate(bolnaValidation.getCallRecords), bolnaController.getCallRecords);

router
  .route('/call-records/sync')
  .post(auth(), requirePermissions('calls.create'), bolnaController.syncMissingCallRecords);

// Refresh re-pulls AI extraction/verification for a record — Call AI Features toggle.
router
  .route('/call-records/:executionId/refresh')
  .post(auth(), requirePermissions('call-ai.manage'), validate(bolnaValidation.getCallStatus), bolnaController.refreshCallRecord);

// Both recordings for a call: Bolna (agent-only) + Plivo (full dual-channel).
// Metadata first, then proxied audio streams (provider URLs need Bolna/Plivo auth).
// Listening requires the Call Recording role toggle (view) on top of Calling view —
// the Recording toggle governs who can hear audio, not just who can toggle recording.
router
  .route('/call-records/:executionId/recordings')
  .get(auth(), requirePermissions('calls.view', 'call-recording.view'), bolnaController.getCallRecordingSources);

router
  .route('/call-records/:executionId/recordings/bolna')
  .get(auth(), requirePermissions('calls.view', 'call-recording.view'), bolnaController.streamBolnaRecording);

router
  .route('/call-records/:executionId/recordings/plivo')
  .get(auth(), requirePermissions('calls.view', 'call-recording.view'), bolnaController.streamPlivoRecording);

router
  .route('/call-records/:executionId/recordings/twilio')
  .get(auth(), requirePermissions('calls.view', 'call-recording.view'), bolnaController.streamTwilioRecording);

router
  .route('/call-records/:id')
  .patch(auth(), requirePermissions('calls.edit'), validate(bolnaValidation.patchCallRecord), bolnaController.patchCallRecord)
  .delete(auth(), requirePermissions('calls.delete'), validate(bolnaValidation.deleteCallRecord), bolnaController.deleteCallRecord);

export default router;

