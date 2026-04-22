import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  requireAnyOfPermissionsOrAdministrator,
  requirePermissionOrAdministrator,
} from '../../middlewares/requirePermissionOrAdministrator.js';
import * as voiceAgentValidation from '../../validations/voiceAgent.validation.js';
import * as voiceAgentController from '../../controllers/voiceAgent.controller.js';

const router = express.Router();

router
  .route('/')
  .get(auth(), requireAnyOfPermissionsOrAdministrator('agents.read', 'agents.manage'), voiceAgentController.listVoiceAgents)
  .post(
    auth(),
    requirePermissionOrAdministrator('agents.manage'),
    validate(voiceAgentValidation.createVoiceAgent),
    voiceAgentController.createVoiceAgent
  );

router
  .route('/:agentId')
  .get(
    auth(),
    requireAnyOfPermissionsOrAdministrator('agents.read', 'agents.manage'),
    validate(voiceAgentValidation.getVoiceAgent),
    voiceAgentController.getVoiceAgent
  )
  .patch(
    auth(),
    requirePermissionOrAdministrator('agents.manage'),
    validate(voiceAgentValidation.updateVoiceAgent),
    voiceAgentController.updateVoiceAgent
  );

export default router;
