import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as shiftValidation from '../../validations/shift.validation.js';
import * as shiftController from '../../controllers/shift.controller.js';

const router = express.Router();

router
  .route('/')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(shiftValidation.createShift),
    shiftController.create
  )
  .get(auth(), requirePermissions('students.read'), validate(shiftValidation.getShifts), shiftController.list);

router
  .route('/:shiftId')
  .get(auth(), requirePermissions('students.read'), validate(shiftValidation.getShift), shiftController.get)
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(shiftValidation.updateShift),
    shiftController.update
  )
  .delete(
    auth(),
    requirePermissions('students.manage'),
    validate(shiftValidation.deleteShift),
    shiftController.remove
  );

export default router;
