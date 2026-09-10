import express from 'express';
import httpStatus from 'http-status';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import requireAdministratorOrPermission from '../../middlewares/requireAdministratorOrPermission.js';
import ApiError from '../../utils/ApiError.js';
import * as taskValidation from '../../validations/task.validation.js';
import * as taskController from '../../controllers/task.controller.js';

const router = express.Router();

const isTruthyQueryFlag = (v) => v === true || v === 'true' || v === '1' || v === 1;

/**
 * List access: org-wide lists need tasks.read (or Administrator bypass).
 * assignedToMe is self-scoped in task.service — allow any authenticated user so
 * dashboard "My Tasks" works without the full tasks.read matrix row.
 */
const requireTaskListAccess = (req, res, next) => {
  if (!req.user || !req.authContext) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
  if (req.user.platformSuperUser || isTruthyQueryFlag(req.query?.assignedToMe)) {
    return next();
  }
  return requireAdministratorOrPermission('tasks.read')(req, res, next);
};

router
  .route('/')
  .post(auth(), requirePermissions('tasks.manage'), validate(taskValidation.createTask), taskController.create)
  .get(auth(), requireTaskListAccess, validate(taskValidation.getTasks), taskController.list);

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
