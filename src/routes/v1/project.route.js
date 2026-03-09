import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as projectValidation from '../../validations/project.validation.js';
import * as projectController from '../../controllers/project.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('projects.manage'), validate(projectValidation.createProject), projectController.create)
  .get(auth(), requirePermissions('projects.read'), validate(projectValidation.getProjects), projectController.list);

router
  .route('/:projectId')
  .get(auth(), requirePermissions('projects.read'), validate(projectValidation.getProject), projectController.get)
  .patch(auth(), requirePermissions('projects.manage'), validate(projectValidation.updateProject), projectController.update)
  .delete(auth(), requirePermissions('projects.manage'), validate(projectValidation.deleteProject), projectController.remove);

export default router;
