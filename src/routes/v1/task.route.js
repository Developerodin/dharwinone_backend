import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as taskValidation from '../../validations/task.validation.js';
import * as taskController from '../../controllers/task.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('tasks.manage'), validate(taskValidation.createTask), taskController.create)
  .get(auth(), requirePermissions('tasks.read'), validate(taskValidation.getTasks), taskController.list);

router
  .route('/:taskId')
  .get(auth(), requirePermissions('tasks.read'), validate(taskValidation.getTask), taskController.get)
  .patch(auth(), requirePermissions('tasks.manage'), validate(taskValidation.updateTask), taskController.update)
  .delete(auth(), requirePermissions('tasks.manage'), validate(taskValidation.deleteTask), taskController.remove);

router
  .route('/:taskId/status')
  .patch(auth(), requirePermissions('tasks.read'), validate(taskValidation.updateTaskStatus), taskController.updateStatus);

router
  .route('/:taskId/comments')
  .get(auth(), requirePermissions('tasks.read'), validate(taskValidation.getTask), taskController.listComments)
  .post(auth(), requirePermissions('tasks.read'), validate(taskValidation.addTaskComment), taskController.createComment);

export default router;
