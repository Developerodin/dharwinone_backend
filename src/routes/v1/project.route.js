import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as projectValidation from '../../validations/project.validation.js';
import * as projectController from '../../controllers/project.controller.js';

const router = express.Router();

/** Main list vs My Projects (?mine=1) use different domain permissions. */
const requireProjectsListAccess = (req, res, next) => {
  const raw = req.query.mine;
  const mineOn =
    raw === true ||
    raw === 1 ||
    ['1', 'true', 'yes'].includes(String(raw ?? '').toLowerCase());
  if (mineOn) {
    return requirePermissions('my-projects.read')(req, res, next);
  }
  return requirePermissions('projects.read')(req, res, next);
};

router
  .route('/')
  .post(auth(), requirePermissions('projects.manage'), validate(projectValidation.createProject), projectController.create)
  .get(auth(), requireProjectsListAccess, validate(projectValidation.getProjects), projectController.list);

router
  .route('/:projectId')
  .get(auth(), requireAnyOfPermissions('projects.read', 'my-projects.read'), validate(projectValidation.getProject), projectController.get)
  .patch(auth(), requirePermissions('projects.manage'), validate(projectValidation.updateProject), projectController.update)
  .delete(auth(), requirePermissions('projects.manage'), validate(projectValidation.deleteProject), projectController.remove);

export default router;
