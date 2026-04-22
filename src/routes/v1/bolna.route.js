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

router
  .route('/call')
  .post(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.initiateCall), bolnaController.initiateCall);

router
  .route('/candidate-call')
  .post(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.initiateCandidateCall), bolnaController.initiateCandidateCall);

router
  .route('/call-status/:executionId')
  .get(auth(), requirePermissions('calls.read'), validate(bolnaValidation.getCallStatus), bolnaController.getCallStatus);

router
  .route('/call-records')
  .get(auth(), requirePermissions('calls.read'), validate(bolnaValidation.getCallRecords), bolnaController.getCallRecords);

router
  .route('/call-records/sync')
  .post(auth(), requirePermissions('calls.manage'), bolnaController.syncMissingCallRecords);

router
  .route('/call-records/:id')
  .delete(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.deleteCallRecord), bolnaController.deleteCallRecord);

export default router;

