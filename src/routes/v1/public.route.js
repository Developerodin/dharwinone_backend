import express from 'express';
import validate from '../../middlewares/validate.js';
import * as authValidation from '../../validations/auth.validation.js';
import * as authController from '../../controllers/auth.controller.js';
import * as livekitValidation from '../../validations/livekit.validation.js';
import * as livekitController from '../../controllers/livekit.controller.js';
import * as meetingValidation from '../../validations/meeting.validation.js';
import * as meetingController from '../../controllers/meeting.controller.js';
import * as jobValidation from '../../validations/job.validation.js';
import * as jobController from '../../controllers/job.controller.js';
import { uploadJobApplicationFiles } from '../../middlewares/upload.js';

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

/**
 * POST /v1/public/meetings/end
 * When host leaves: mark meeting as ended. Body: { roomName, hostEmail } – host only
 */
router.post(
  '/meetings/end',
  validate(meetingValidation.endMeetingByRoomPublic),
  meetingController.endMeetingByRoomPublic
);

/**
 * GET /v1/public/jobs
 * Public job listing (no auth). Returns only Active jobs with pagination and filters.
 */
router.get('/jobs', validate(jobValidation.listPublicJobs), jobController.listPublicJobs);

/**
 * GET /v1/public/jobs/:jobId
 * Public job details (no auth). Returns job if status is Active.
 */
router.get('/jobs/:jobId', validate(jobValidation.getPublicJob), jobController.getPublicJob);

/**
 * POST /v1/public/jobs/:jobId/apply
 * Public job application (no auth). Creates user, candidate with resume, and job application.
 * Returns auth tokens for auto-login.
 */
router.post(
  '/jobs/:jobId/apply',
  uploadJobApplicationFiles,
  validate(jobValidation.publicApplyToJob),
  jobController.publicApplyToJob
);

export default router;
