import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import requireAdministratorOrPermission from '../../middlewares/requireAdministratorOrPermission.js';
import * as meetingValidation from '../../validations/meeting.validation.js';
import * as meetingController from '../../controllers/meeting.controller.js';
import * as meetingExcelController from '../../controllers/meetingExcel.controller.js';
import * as interviewTranscriptController from '../../controllers/interviewTranscript.controller.js';
import * as interviewEvaluationValidation from '../../validations/interviewEvaluation.validation.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.createMeeting), meetingController.create)
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeetings), meetingController.list);

// Candidate self-service — auth only (no interviews.read). MUST be before /:id.
router
  .route('/my-interviews')
  .get(auth(), validate(meetingValidation.getMyInterviews), meetingController.listMyInterviews);

// Excel export of interviews (MUST be before /:id so "export" isn't captured as an id)
router.post(
  '/export',
  auth(),
  requirePermissions('interviews.read'),
  validate(meetingValidation.exportMeetings),
  meetingExcelController.exportExcel
);

router
  .route('/:id/resend-invitations')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.resendInvitations), meetingController.resendInvitations);

router
  .route('/:id/move-to-preboarding')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.getMeeting), meetingController.moveToPreboarding);

// Internal mobility — transfer an existing employee to a new role post-interview. Distinct
// `employees.transfer` capability (restrictable to HR/managers separately from recruiters).
// Administrator + platformSuperUser bypass; other roles need the `ats.employees.transfer:*` matrix row
// (no migration needed) — mirrors the users.impersonate pattern.
router
  .route('/:id/internal-transfer')
  .post(
    auth(),
    requireAdministratorOrPermission('employees.transfer', ['Administrator']),
    validate(meetingValidation.internalTransfer),
    meetingController.internalTransfer
  );

router
  .route('/:id/recordings')
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeetingRecordings), meetingController.getRecordings);

router
  .route('/:id/transcript/utterances/:utteranceId/context')
  .get(
    auth(),
    requireAnyOfPermissions('interviews.transcript.read', 'interviews.evaluation.read'),
    validate(interviewEvaluationValidation.getMeetingTranscriptUtteranceContext),
    interviewTranscriptController.getTranscriptUtteranceContext
  );

router
  .route('/:id/transcript')
  .get(
    auth(),
    requirePermissions('interviews.transcript.read'),
    validate(interviewEvaluationValidation.getMeetingTranscript),
    interviewTranscriptController.getTranscript
  );

router
  .route('/:id/summary')
  .get(
    auth(),
    requirePermissions('interviews.summary.read'),
    validate(interviewEvaluationValidation.getMeetingSummary),
    interviewTranscriptController.getSummary
  );

router
  .route('/:id/linkage')
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeetingLinkage), meetingController.getLinkage)
  .patch(
    auth(),
    requirePermissions('interviews.manage'),
    validate(meetingValidation.patchMeetingLinkage),
    meetingController.patchLinkage
  );

router
  .route('/:id/application')
  .post(
    auth(),
    requirePermissions('interviews.manage', 'candidates.manage'),
    validate(meetingValidation.createMeetingApplication),
    meetingController.createApplication
  );

router
  .route('/:id')
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeeting), meetingController.get)
  .patch(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.updateMeeting), meetingController.update)
  .delete(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.deleteMeeting), meetingController.remove);

export default router;
