import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as meetingValidation from '../../validations/meeting.validation.js';
import * as meetingController from '../../controllers/meeting.controller.js';
import * as meetingExcelController from '../../controllers/meetingExcel.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.createMeeting), meetingController.create)
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeetings), meetingController.list);

// Excel export of interviews (MUST be before /:id so "export" isn't captured as an id)
router.get('/export', auth(), requirePermissions('interviews.read'), meetingExcelController.exportExcel);

router
  .route('/:id/resend-invitations')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.resendInvitations), meetingController.resendInvitations);

router
  .route('/:id/move-to-preboarding')
  .post(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.getMeeting), meetingController.moveToPreboarding);

router
  .route('/:id/recordings')
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeetingRecordings), meetingController.getRecordings);

router
  .route('/:id')
  .get(auth(), requirePermissions('interviews.read'), validate(meetingValidation.getMeeting), meetingController.get)
  .patch(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.updateMeeting), meetingController.update)
  .delete(auth(), requirePermissions('interviews.manage'), validate(meetingValidation.deleteMeeting), meetingController.remove);

export default router;
