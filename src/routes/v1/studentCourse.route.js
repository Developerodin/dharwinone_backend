import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as studentCourseValidation from '../../validations/studentCourse.validation.js';
import * as studentCourseController from '../../controllers/studentCourse.controller.js';

const router = express.Router();

// Get all courses for a student
router
  .route('/:studentId/courses')
  .get(
    auth(),
    requirePermissions('students.courses.read'),
    validate(studentCourseValidation.getStudentCourses),
    studentCourseController.getStudentCourses
  );

// Get single course with full details
router
  .route('/:studentId/courses/:moduleId')
  .get(
    auth(),
    requirePermissions('students.courses.read'),
    validate(studentCourseValidation.getStudentCourse),
    studentCourseController.getStudentCourse
  );

// Start course
router
  .route('/:studentId/courses/:moduleId/start')
  .post(
    auth(),
    requirePermissions('students.courses.manage'),
    validate(studentCourseValidation.startCourse),
    studentCourseController.startCourse
  );

// Mark playlist item as complete
router
  .route('/:studentId/courses/:moduleId/complete-item')
  .post(
    auth(),
    requirePermissions('students.courses.manage'),
    validate(studentCourseValidation.markItemComplete),
    studentCourseController.markItemComplete
  );

// Update last accessed item
router
  .route('/:studentId/courses/:moduleId/last-accessed')
  .patch(
    auth(),
    requirePermissions('students.courses.read'),
    validate(studentCourseValidation.updateLastAccessed),
    studentCourseController.updateLastAccessed
  );

// Certificate endpoints
import * as certificateValidation from '../../validations/certificate.validation.js';
import * as certificateController from '../../controllers/certificate.controller.js';

// Generate certificate (manual trigger)
router
  .route('/:studentId/courses/:moduleId/certificate')
  .post(
    auth(),
    requirePermissions('students.courses.manage'),
    validate(certificateValidation.generateCertificate),
    certificateController.generateCertificate
  )
  .get(
    auth(),
    requirePermissions('students.courses.read'),
    validate(certificateValidation.getCertificate),
    certificateController.getCertificate
  );

export default router;
