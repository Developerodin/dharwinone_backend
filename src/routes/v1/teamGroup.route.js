import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as teamGroupValidation from '../../validations/teamGroup.validation.js';
import * as teamGroupController from '../../controllers/teamGroup.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('teams.manage'), validate(teamGroupValidation.createTeamGroup), teamGroupController.create)
  .get(auth(), requirePermissions('teams.read'), validate(teamGroupValidation.getTeamGroups), teamGroupController.list);

router
  .route('/:teamGroupId')
  .get(auth(), requirePermissions('teams.read'), validate(teamGroupValidation.getTeamGroup), teamGroupController.get)
  .patch(auth(), requirePermissions('teams.manage'), validate(teamGroupValidation.updateTeamGroup), teamGroupController.update)
  .delete(auth(), requirePermissions('teams.manage'), validate(teamGroupValidation.deleteTeamGroup), teamGroupController.remove);

export default router;
