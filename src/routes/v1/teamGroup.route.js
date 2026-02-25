import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as teamGroupValidation from '../../validations/teamGroup.validation.js';
import * as teamGroupController from '../../controllers/teamGroup.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), validate(teamGroupValidation.createTeamGroup), teamGroupController.create)
  .get(auth(), validate(teamGroupValidation.getTeamGroups), teamGroupController.list);

router
  .route('/:teamGroupId')
  .get(auth(), validate(teamGroupValidation.getTeamGroup), teamGroupController.get)
  .patch(auth(), validate(teamGroupValidation.updateTeamGroup), teamGroupController.update)
  .delete(auth(), validate(teamGroupValidation.deleteTeamGroup), teamGroupController.remove);

export default router;
