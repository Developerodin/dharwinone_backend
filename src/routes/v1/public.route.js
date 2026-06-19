import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as authValidation from '../../validations/auth.validation.js';
import * as authController from '../../controllers/auth.controller.js';
import * as livekitValidation from '../../validations/livekit.validation.js';
import * as livekitController from '../../controllers/livekit.controller.js';
import * as meetingValidation from '../../validations/meeting.validation.js';
import * as meetingController from '../../controllers/meeting.controller.js';
import * as jobValidation from '../../validations/job.validation.js';
import * as jobController from '../../controllers/job.controller.js';
import * as plivoController from '../../controllers/plivo.controller.js';
import { uploadJobApplicationFiles } from '../../middlewares/upload.js';
import { publicRegistrationLimiter, publicWriteLimiter } from '../../middlewares/rateLimiter.js';

const router = express.Router();

/**
 * POST /v1/public/register
 * Public registration (no auth). Creates user with status 'pending'.
 * User cannot login or access the system until an administrator sets status to 'active'.
 * No tokens or cookies are issued.
 */
router.post('/register', publicRegistrationLimiter, validate(authValidation.register), authController.publicRegister);

/**
 * POST /v1/public/register-candidate
 * Public candidate onboarding (no auth). Creates user with status 'pending' and a Candidate
 * linked to that user so they appear in the ATS candidate list.
 */
router.post(
  '/register-candidate',
  publicRegistrationLimiter,
  validate(authValidation.registerCandidate),
  authController.publicRegisterCandidate
);

/**
 * POST /v1/public/livekit-token
 * Public LiveKit token (no auth). Body: { roomName, participantName }
 */
router.post('/livekit-token', publicWriteLimiter, validate(livekitValidation.getToken), livekitController.getTokenPublic);

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
  auth(),
  publicWriteLimiter,
  validate(livekitValidation.admitParticipantPublic),
  livekitController.admitParticipantPublic
);

/**
 * POST /v1/public/remove-participant
 * Public endpoint to remove a waiting participant (no auth required)
 * Host verification happens via email check in the controller
 */
router.post(
  '/remove-participant',
  auth(),
  publicWriteLimiter,
  validate(livekitValidation.removeParticipantPublic),
  livekitController.removeParticipantPublic
);

/**
 * POST /v1/public/recording/start
 * Public recording start (no auth). Host email verified server-side via isParticipantHost.
 * Body: { roomName, hostEmail }
 */
router.post(
  '/recording/start',
  auth(),
  publicWriteLimiter,
  validate(livekitValidation.startRecordingPublic),
  livekitController.startRecordingPublic
);

/**
 * POST /v1/public/recording/stop
 * Public recording stop (no auth). Host email verified server-side via isParticipantHost.
 * Body: { egressId, roomName, hostEmail }
 */
router.post(
  '/recording/stop',
  auth(),
  publicWriteLimiter,
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
  auth(),
  publicWriteLimiter,
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
 *
 * B11 fix: lightweight CAPTCHA gate. When CAPTCHA_REQUIRED=true the request must include a
 * non-empty `x-captcha-token` header (or `captchaToken` body field). Real verification (hCaptcha /
 * reCaptcha / Cloudflare Turnstile) plugs into this middleware later — wire the provider call
 * and reject on failure. Default ships open so existing clients keep working.
 */
const captchaGate = (req, res, next) => {
  if (String(process.env.CAPTCHA_REQUIRED || '').toLowerCase() !== 'true') return next();
  const token = req.headers['x-captcha-token'] || req.body?.captchaToken;
  if (!token || String(token).trim().length === 0) {
    return res.status(400).json({ code: 400, message: 'Captcha verification required', errorCode: 'CAPTCHA_REQUIRED' });
  }
  // TODO: verify token with provider (hCaptcha / reCaptcha / Turnstile) before next().
  return next();
};

router.post(
  '/jobs/:jobId/apply',
  publicRegistrationLimiter,
  captchaGate,
  uploadJobApplicationFiles,
  validate(jobValidation.publicApplyToJob),
  jobController.publicApplyToJob
);

/**
 * GET /v1/public/plivo/answer
 * Plivo answer webhook for click-to-call bridges (no auth — Plivo's servers hit it).
 * The `sig` HMAC over `to|callerId` gates it so it can't be abused to dial arbitrary
 * numbers. Returns Plivo XML that dials `to` with the bought number as caller ID.
 */
router.get('/plivo/answer', plivoController.answerCall);

router.all('/plivo/sdk-answer/i/:intent', plivoController.sdkAnswer);

/**
 * GET|POST /v1/public/plivo/sdk-answer
 * Plivo answer webhook for browser-SDK (WebRTC) calls. No auth — Plivo's servers
 * hit it. Returns <Dial> XML bridging to the dialed number with the chosen bought
 * caller ID. A real call only reaches here from our token-authenticated endpoint.
 */
router.all('/plivo/sdk-answer', plivoController.sdkAnswer);

export default router;
