import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as studentValidation from '../../validations/student.validation.js';
import * as studentController from '../../controllers/student.controller.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router
  .route('/')
  .get(auth(), requirePermissions('students.read'), validate(studentValidation.getStudents), studentController.getStudents);

// Upload / fetch student profile image
router
  .route('/:studentId/profile-image')
  .post(
    auth(),
    requirePermissions('students.manage'),
    upload.single('file'),
    studentController.uploadProfileImage
  )
  .get(auth(), requirePermissions('students.read'), studentController.getProfileImage);

router
  .route('/:studentId')
  .get(auth(), requirePermissions('students.read'), validate(studentValidation.getStudent), studentController.getStudent)
  .patch(auth(), requirePermissions('students.manage'), validate(studentValidation.updateStudent), studentController.updateStudent)
  .delete(auth(), requirePermissions('students.manage'), validate(studentValidation.deleteStudent), studentController.deleteStudent);

export default router;
