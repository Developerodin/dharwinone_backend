import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as teamValidation from '../../validations/team.validation.js';
import * as teamController from '../../controllers/team.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), validate(teamValidation.createTeamMember), teamController.create)
  .get(auth(), validate(teamValidation.getTeamMembers), teamController.list);

router
  .route('/:teamMemberId')
  .get(auth(), validate(teamValidation.getTeamMember), teamController.get)
  .patch(auth(), validate(teamValidation.updateTeamMember), teamController.update)
  .delete(auth(), validate(teamValidation.deleteTeamMember), teamController.remove);

export default router;

