import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as bolnaValidation from '../../validations/bolna.validation.js';
import * as bolnaController from '../../controllers/bolna.controller.js';

const router = express.Router();

router
  .route('/call')
  .post(auth(), validate(bolnaValidation.initiateCall), bolnaController.initiateCall);

router
  .route('/candidate-call')
  .post(auth(), validate(bolnaValidation.initiateCandidateCall), bolnaController.initiateCandidateCall);

router
  .route('/call-status/:executionId')
  .get(auth(), validate(bolnaValidation.getCallStatus), bolnaController.getCallStatus);

router
  .route('/call-records')
  .get(auth(), validate(bolnaValidation.getCallRecords), bolnaController.getCallRecords);

router
  .route('/call-records/sync')
  .post(auth(), bolnaController.syncMissingCallRecords);

router
  .route('/call-records/:id')
  .delete(auth(), validate(bolnaValidation.deleteCallRecord), bolnaController.deleteCallRecord);

export default router;

