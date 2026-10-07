import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as leaveRequestValidation from '../../validations/leaveRequest.validation.js';
import * as leaveRequestController from '../../controllers/leaveRequest.controller.js';

const router = express.Router();

router
  .route('/student/:studentId')
  .post(auth(), validate(leaveRequestValidation.createLeaveRequest), leaveRequestController.create)
  .get(auth(), validate(leaveRequestValidation.getLeaveRequestsByStudent), leaveRequestController.getByStudent);

router.route('/').get(auth(), validate(leaveRequestValidation.getLeaveRequests), leaveRequestController.list);

router.route('/:requestId').get(auth(), validate(leaveRequestValidation.getLeaveRequest), leaveRequestController.get);

router
  .route('/:requestId/approve')
  .patch(
    auth(),
    requirePermissions('attendance.assign'),
    validate(leaveRequestValidation.approveLeaveRequest),
    leaveRequestController.approve
  );

router
  .route('/:requestId/reject')
  .patch(
    auth(),
    requirePermissions('attendance.assign'),
    validate(leaveRequestValidation.rejectLeaveRequest),
    leaveRequestController.reject
  );

router
  .route('/:requestId/cancel')
  .post(auth(), validate(leaveRequestValidation.cancelLeaveRequest), leaveRequestController.cancel);

export default router;
