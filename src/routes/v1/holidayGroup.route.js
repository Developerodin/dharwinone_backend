import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as holidayGroupValidation from '../../validations/holidayGroup.validation.js';
import * as holidayGroupController from '../../controllers/holidayGroup.controller.js';

const router = express.Router();

router
  .route('/')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayGroupValidation.createHolidayGroup),
    holidayGroupController.create
  )
  .get(
    auth(),
    requirePermissions('students.read'),
    validate(holidayGroupValidation.getHolidayGroups),
    holidayGroupController.list
  );

router
  .route('/:groupId')
  .get(
    auth(),
    requirePermissions('students.read'),
    validate(holidayGroupValidation.getHolidayGroup),
    holidayGroupController.get
  )
  .patch(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayGroupValidation.updateHolidayGroup),
    holidayGroupController.update
  )
  .delete(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayGroupValidation.deleteHolidayGroup),
    holidayGroupController.remove
  );

router
  .route('/:groupId/assign')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayGroupValidation.groupAction),
    holidayGroupController.assign
  );

router
  .route('/:groupId/remove')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(holidayGroupValidation.groupAction),
    holidayGroupController.unassign
  );

export default router;
