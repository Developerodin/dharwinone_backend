import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as holidayValidation from '../../validations/holiday.validation.js';
import * as holidayController from '../../controllers/holiday.controller.js';

const router = express.Router();

router
  .route('/')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayValidation.createHoliday),
    holidayController.create
  )
  .get(auth(), requirePermissions('students.read'), validate(holidayValidation.getHolidays), holidayController.list);

router
  .route('/:holidayId')
  .get(auth(), requirePermissions('students.read'), validate(holidayValidation.getHoliday), holidayController.get)
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayValidation.updateHoliday),
    holidayController.update
  )
  .delete(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayValidation.deleteHoliday),
    holidayController.remove
  );

export default router;
