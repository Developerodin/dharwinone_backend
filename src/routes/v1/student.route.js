import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import requireStudentsReadOrOwnStudent from '../../middlewares/requireStudentsReadOrOwnStudent.js';
import * as studentValidation from '../../validations/student.validation.js';
import * as studentController from '../../controllers/student.controller.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router
  .route('/')
  .get(auth(), requirePermissions('students.read'), validate(studentValidation.getStudents), studentController.getStudents);

// Users with Student role but no Training student profile (so they don't appear in assignment)
router.get(
  '/users-without-profile',
  auth(),
  requirePermissions('students.read'),
  studentController.getUsersWithoutStudentProfile
);

// Create student profile for an existing user (so they appear in assignment)
router.post(
  '/from-user',
  auth(),
  requirePermissions('students.manage'),
  validate(studentValidation.createStudentFromUser),
  studentController.createStudentFromUser
);

// Must be before /:studentId so "me" is not captured as studentId
router.get('/me', auth(), requirePermissions('students.courses.read'), studentController.getMyProfile);

// Assign shift - MUST be before /:studentId
router
  .route('/assign-shift')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(studentValidation.assignShift),
    studentController.assignShift
  );

// Week-off: bulk import by email (MUST be before /week-off)
router.post(
  '/week-off/import',
  auth(),
  requirePermissions('students.manage'),
  validate(studentValidation.importWeekOff),
  studentController.importWeekOff
);
// Week-off calendar - MUST be before /:studentId
router
  .route('/week-off')
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(studentValidation.updateWeekOff),
    studentController.updateWeekOff
  );
router
  .route('/:studentId/week-off')
  .get(auth(), requirePermissions('students.read'), validate(studentValidation.getWeekOff), studentController.getWeekOff);

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
  .get(auth(), requireStudentsReadOrOwnStudent, validate(studentValidation.getStudent), studentController.getStudent)
  .patch(auth(), requirePermissions('students.manage'), validate(studentValidation.updateStudent), studentController.updateStudent)
  .delete(auth(), requirePermissions('students.manage'), validate(studentValidation.deleteStudent), studentController.deleteStudent);

export default router;
