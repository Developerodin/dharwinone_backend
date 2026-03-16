import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as backdatedAttendanceRequestValidation from '../../validations/backdatedAttendanceRequest.validation.js';
import * as backdatedAttendanceRequestController from '../../controllers/backdatedAttendanceRequest.controller.js';

const router = express.Router();

router
  .route('/me')
  .post(
    auth(),
    validate(backdatedAttendanceRequestValidation.createBackdatedAttendanceRequestMe),
    backdatedAttendanceRequestController.createMe
  )
  .get(
    auth(),
    validate(backdatedAttendanceRequestValidation.getBackdatedAttendanceRequestsByUserMe),
    backdatedAttendanceRequestController.getByUserMe
  );

router
  .route('/student/:studentId')
  .post(
    auth(),
    validate(backdatedAttendanceRequestValidation.createBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.create
  )
  .get(
    auth(),
    validate(backdatedAttendanceRequestValidation.getBackdatedAttendanceRequestsByStudent),
    backdatedAttendanceRequestController.getByStudent
  );

router
  .route('/')
  .get(
    auth(),
    validate(backdatedAttendanceRequestValidation.getBackdatedAttendanceRequests),
    backdatedAttendanceRequestController.list
  );

router
  .route('/:requestId')
  .get(
    auth(),
    validate(backdatedAttendanceRequestValidation.getBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.get
  )
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(backdatedAttendanceRequestValidation.updateBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.update
  );

router
  .route('/:requestId/approve')
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(backdatedAttendanceRequestValidation.approveBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.approve
  );

router
  .route('/:requestId/reject')
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(backdatedAttendanceRequestValidation.rejectBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.reject
  );

router
  .route('/:requestId/cancel')
  .post(
    auth(),
    validate(backdatedAttendanceRequestValidation.cancelBackdatedAttendanceRequest),
    backdatedAttendanceRequestController.cancel
  );

export default router;
