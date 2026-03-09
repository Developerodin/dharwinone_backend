import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as teamValidation from '../../validations/team.validation.js';
import * as teamController from '../../controllers/team.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('teams.manage'), validate(teamValidation.createTeamMember), teamController.create)
  .get(auth(), requirePermissions('teams.read'), validate(teamValidation.getTeamMembers), teamController.list);

router
  .route('/:teamMemberId')
  .get(auth(), requirePermissions('teams.read'), validate(teamValidation.getTeamMember), teamController.get)
  .patch(auth(), requirePermissions('teams.manage'), validate(teamValidation.updateTeamMember), teamController.update)
  .delete(auth(), requirePermissions('teams.manage'), validate(teamValidation.deleteTeamMember), teamController.remove);

export default router;

