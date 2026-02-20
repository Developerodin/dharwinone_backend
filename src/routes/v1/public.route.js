import express from 'express';
import validate from '../../middlewares/validate.js';
import * as authValidation from '../../validations/auth.validation.js';
import * as authController from '../../controllers/auth.controller.js';
import * as livekitValidation from '../../validations/livekit.validation.js';
import * as livekitController from '../../controllers/livekit.controller.js';

const router = express.Router();

/**
 * POST /v1/public/register
 * Public registration (no auth). Creates user with status 'pending'.
 * User cannot login or access the system until an administrator sets status to 'active'.
 * No tokens or cookies are issued.
 */
router.post('/register', validate(authValidation.register), authController.publicRegister);

/**
 * POST /v1/public/register-candidate
 * Public candidate onboarding (no auth). Creates user with status 'pending' and a Candidate
 * linked to that user so they appear in the ATS candidate list.
 */
router.post('/register-candidate', validate(authValidation.registerCandidate), authController.publicRegisterCandidate);

/**
 * POST /v1/public/livekit-token
 * Public LiveKit token (no auth). Body: { roomName, participantName }
 */
router.post('/livekit-token', validate(livekitValidation.getToken), livekitController.getTokenPublic);

/**
 * GET /v1/public/waiting-participants/:roomName
 * Public endpoint to get waiting participants (no auth required)
 * Host verification happens via email check in the controller
 */
router.get(
  '/waiting-participants/:roomName',
  validate(livekitValidation.getWaitingParticipants),
  livekitController.getWaitingParticipantsPublic
);

/**
 * POST /v1/public/admit-participant
 * Public endpoint to admit a waiting participant (no auth required)
 * Host verification happens via email check in the controller
 */
router.post(
  '/admit-participant',
  validate(livekitValidation.admitParticipant),
  livekitController.admitParticipantPublic
);

/**
 * POST /v1/public/remove-participant
 * Public endpoint to remove a waiting participant (no auth required)
 * Host verification happens via email check in the controller
 */
router.post(
  '/remove-participant',
  validate(livekitValidation.removeParticipant),
  livekitController.removeParticipantPublic
);

/**
 * POST /v1/public/recording/start
 * Body: { roomName, hostEmail } – host only
 */
router.post(
  '/recording/start',
  validate(livekitValidation.startRecordingPublic),
  livekitController.startRecordingPublic
);

/**
 * POST /v1/public/recording/stop
 * Body: { egressId, roomName, hostEmail } – host only
 */
router.post(
  '/recording/stop',
  validate(livekitValidation.stopRecordingPublic),
  livekitController.stopRecordingPublic
);

/**
 * GET /v1/public/recording/status/:roomName
 * No auth – anyone can check if room is recording
 */
router.get(
  '/recording/status/:roomName',
  validate(livekitValidation.getRecordingStatusPublic),
  livekitController.getRecordingStatusPublic
);

export default router;
