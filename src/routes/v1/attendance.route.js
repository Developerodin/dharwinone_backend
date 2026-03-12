import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import requireAttendanceAccess from '../../middlewares/requireAttendanceAccess.js';
import { attendancePunchLimiter } from '../../middlewares/rateLimiter.js';
import * as attendanceValidation from '../../validations/attendance.validation.js';
import attendanceController from '../../controllers/attendance.controller.js';

const router = express.Router();

// Get current user's student for attendance (Candidate, Agent, Student, etc. - auto-creates if needed). Admins get 404.
router.get('/me', auth(), attendanceController.getMyStudentForAttendance);

// Track list and history: admin only (students.manage) - agents see punch UI only
router.get('/track', auth(), requirePermissions('students.manage'), validate(attendanceValidation.trackList), attendanceController.getTrackList);
router.get(
  '/track/history',
  auth(),
  requirePermissions('students.manage'),
  validate(attendanceValidation.trackHistory),
  attendanceController.getTrackHistory
);

// Assign/remove holidays to students (admin or agent with attendance.manage)
router
  .route('/holidays')
  .post(
    auth(),
    requirePermissions('attendance.assign'),
    validate(attendanceValidation.addHolidaysToStudents),
    attendanceController.addHolidays
  )
  .delete(
    auth(),
    requirePermissions('attendance.assign'),
    validate(attendanceValidation.removeHolidaysFromStudents),
    attendanceController.removeHolidays
  );

router.post(
  '/leave',
  auth(),
  requirePermissions('attendance.assign'),
  validate(attendanceValidation.assignLeavesToStudents),
  attendanceController.assignLeave
);

router.post(
  '/student/:studentId/regularize',
  auth(),
  requirePermissions('attendance.assign'),
  validate(attendanceValidation.regularizeAttendance),
  attendanceController.regularize
);

router.use(auth(), requireAttendanceAccess);

router.post(
  '/punch-in/:studentId',
  attendancePunchLimiter,
  validate(attendanceValidation.punchIn),
  attendanceController.punchIn
);

router.post(
  '/punch-out/:studentId',
  attendancePunchLimiter,
  validate(attendanceValidation.punchOut),
  attendanceController.punchOut
);

router.get(
  '/status/:studentId',
  validate(attendanceValidation.studentIdParam),
  attendanceController.getStatus
);

router.get(
  '/student/:studentId',
  validate(attendanceValidation.listAttendance),
  attendanceController.getStudentAttendance
);

router.get(
  '/statistics/:studentId',
  validate(attendanceValidation.getStatistics),
  attendanceController.getStatistics
);

export default router;
