import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as taskValidation from '../../validations/task.validation.js';
import * as taskController from '../../controllers/task.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), validate(taskValidation.createTask), taskController.create)
  .get(auth(), validate(taskValidation.getTasks), taskController.list);

router
  .route('/:taskId')
  .get(auth(), validate(taskValidation.getTask), taskController.get)
  .patch(auth(), validate(taskValidation.updateTask), taskController.update)
  .delete(auth(), validate(taskValidation.deleteTask), taskController.remove);

router
  .route('/:taskId/status')
  .patch(auth(), validate(taskValidation.updateTaskStatus), taskController.updateStatus);

export default router;
