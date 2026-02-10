import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as mentorValidation from '../../validations/mentor.validation.js';
import * as mentorController from '../../controllers/mentor.controller.js';

const router = express.Router();

router
  .route('/')
  .get(auth(), requirePermissions('mentors.read'), validate(mentorValidation.getMentors), mentorController.getMentors);

router
  .route('/:mentorId')
  .get(auth(), requirePermissions('mentors.read'), validate(mentorValidation.getMentor), mentorController.getMentor)
  .patch(auth(), requirePermissions('mentors.manage'), validate(mentorValidation.updateMentor), mentorController.updateMentor)
  .delete(auth(), requirePermissions('mentors.manage'), validate(mentorValidation.deleteMentor), mentorController.deleteMentor);

export default router;
