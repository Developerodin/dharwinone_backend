import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as mentorValidation from '../../validations/mentor.validation.js';
import * as mentorController from '../../controllers/mentor.controller.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router
  .route('/')
  .get(auth(), requirePermissions('mentors.read'), validate(mentorValidation.getMentors), mentorController.getMentors);

// Upload / fetch mentor profile image
router
  .route('/:mentorId/profile-image')
  .post(
    auth(),
    requirePermissions('mentors.manage'),
    upload.single('file'),
    mentorController.uploadProfileImage
  )
  .get(auth(), requirePermissions('mentors.read'), mentorController.getProfileImage);

router
  .route('/:mentorId')
  .get(auth(), requirePermissions('mentors.read'), validate(mentorValidation.getMentor), mentorController.getMentor)
  .patch(auth(), requirePermissions('mentors.manage'), validate(mentorValidation.updateMentor), mentorController.updateMentor)
  .delete(auth(), requirePermissions('mentors.manage'), validate(mentorValidation.deleteMentor), mentorController.deleteMentor);

export default router;
