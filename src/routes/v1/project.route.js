import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as projectValidation from '../../validations/project.validation.js';
import * as projectController from '../../controllers/project.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), validate(projectValidation.createProject), projectController.create)
  .get(auth(), validate(projectValidation.getProjects), projectController.list);

router
  .route('/:projectId')
  .get(auth(), validate(projectValidation.getProject), projectController.get)
  .patch(auth(), validate(projectValidation.updateProject), projectController.update)
  .delete(auth(), validate(projectValidation.deleteProject), projectController.remove);

export default router;
