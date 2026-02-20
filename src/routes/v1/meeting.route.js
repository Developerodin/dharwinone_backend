import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as meetingValidation from '../../validations/meeting.validation.js';
import * as meetingController from '../../controllers/meeting.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), validate(meetingValidation.createMeeting), meetingController.create)
  .get(auth(), validate(meetingValidation.getMeetings), meetingController.list);

router
  .route('/:id/resend-invitations')
  .post(auth(), validate(meetingValidation.resendInvitations), meetingController.resendInvitations);

router
  .route('/:id/recordings')
  .get(auth(), validate(meetingValidation.getMeetingRecordings), meetingController.getRecordings);

router
  .route('/:id')
  .get(auth(), validate(meetingValidation.getMeeting), meetingController.get)
  .patch(auth(), validate(meetingValidation.updateMeeting), meetingController.update)
  .delete(auth(), validate(meetingValidation.deleteMeeting), meetingController.remove);

export default router;
