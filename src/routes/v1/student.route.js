import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import requireStudentsReadOrOwnStudent from '../../middlewares/requireStudentsReadOrOwnStudent.js';
import * as studentValidation from '../../validations/student.validation.js';
import * as studentController from '../../controllers/student.controller.js';
import * as studentExcelController from '../../controllers/studentExcel.controller.js';
import * as weekOffExportController from '../../controllers/weekOffExport.controller.js';
import * as studentNoteController from '../../controllers/studentNote.controller.js';
import * as studentNoteValidation from '../../validations/studentNote.validation.js';
import { studentProfileImageUpload } from '../../middlewares/upload.js';

const router = express.Router();

router
  .route('/')
  .get(auth(), requirePermissions('students.read'), validate(studentValidation.getStudents), studentController.getStudents);

router.get(
  '/filter-options',
  auth(),
  requirePermissions('students.read'),
  validate(studentValidation.getStudentFilterOptions),
  studentController.getStudentFilterOptions
);

// Excel export of students (MUST be before /:studentId so "export" isn't captured as an id)
router.get('/export', auth(), requirePermissions('students.read'), studentExcelController.exportExcel);

router
  .route('/:studentId/notes')
  .get(
    auth(),
    requirePermissions('students.read'),
    validate(studentNoteValidation.listNotes),
    studentNoteController.listNotes
  )
  .post(
    auth(),
    requirePermissions('students.manage'),
    validate(studentNoteValidation.createNote),
    studentNoteController.createNote
  );

router.delete(
  '/notes/:noteId',
  auth(),
  requirePermissions('students.manage'),
  validate(studentNoteValidation.deleteNote),
  studentNoteController.deleteNote
);

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
  requirePermissions('attendance.assign'),
  validate(studentValidation.importWeekOff),
  studentController.importWeekOff
);
router.get(
  '/week-off/export',
  auth(),
  requirePermissions('attendance.assign'),
  validate(studentValidation.exportWeekOff),
  weekOffExportController.exportWeekOffExcel
);
router.get(
  '/week-off/counts',
  auth(),
  requirePermissions('attendance.assign'),
  validate(studentValidation.listWeekOffDayCounts),
  weekOffExportController.listWeekOffDayCounts
);
router.get(
  '/week-off/assignments',
  auth(),
  requirePermissions('attendance.assign'),
  validate(studentValidation.listWeekOffAssignments),
  weekOffExportController.listWeekOffAssignments
);
router.post(
  '/week-off/unassign',
  auth(),
  requirePermissions('attendance.assign'),
  validate(studentValidation.unassignWeekOffDay),
  weekOffExportController.unassignWeekOffDay
);
// Week-off calendar - MUST be before /:studentId
router
  .route('/week-off')
  .post(
    auth(),
    requirePermissions('attendance.assign'),
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
    studentProfileImageUpload.single('file'),
    studentController.uploadProfileImage
  )
  .get(auth(), requirePermissions('students.read'), studentController.getProfileImage);

router
  .route('/:studentId')
  .get(auth(), requireStudentsReadOrOwnStudent, validate(studentValidation.getStudent), studentController.getStudent)
  .patch(auth(), requirePermissions('students.manage'), validate(studentValidation.updateStudent), studentController.updateStudent)
  .delete(auth(), requirePermissions('students.manage'), validate(studentValidation.deleteStudent), studentController.deleteStudent);

export default router;
