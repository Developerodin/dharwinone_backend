import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as sprintValidation from '../../validations/sprint.validation.js';
import * as sprintController from '../../controllers/sprint.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('tasks.manage'), validate(sprintValidation.createSprint), sprintController.create)
  .get(auth(), requirePermissions('tasks.read'), validate(sprintValidation.getSprints), sprintController.list);

router
  .route('/:sprintId')
  .get(auth(), requirePermissions('tasks.read'), validate(sprintValidation.getSprint), sprintController.get)
  .patch(auth(), requirePermissions('tasks.manage'), validate(sprintValidation.updateSprint), sprintController.update)
  .delete(auth(), requirePermissions('tasks.manage'), validate(sprintValidation.deleteSprint), sprintController.remove);

export default router;
