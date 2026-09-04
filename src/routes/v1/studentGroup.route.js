import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as studentGroupValidation from '../../validations/studentGroup.validation.js';
import * as studentGroupController from '../../controllers/studentGroup.controller.js';

const router = express.Router();

const requireAttendanceAssign = requirePermissions('attendance.assign');
const requireStudentsManage = requirePermissions('students.manage');

router
  .route('/')
  .post(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.createStudentGroup),
    studentGroupController.create
  )
  .get(
    auth(),
    requireAttendanceAssign,
    validate(studentGroupValidation.getStudentGroups),
    studentGroupController.list
  );

router
  .route('/:groupId/students')
  .get(
    auth(),
    requireAttendanceAssign,
    validate(studentGroupValidation.getGroupStudents),
    studentGroupController.listGroupStudents
  )
  .post(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.addStudentsToGroup),
    studentGroupController.addStudents
  );

router
  .route('/:groupId/students/remove')
  .post(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.removeStudentsFromGroup),
    studentGroupController.removeStudents
  );

router
  .route('/:groupId/holidays')
  .post(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.assignHolidaysToGroup),
    studentGroupController.assignHolidays
  )
  .delete(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.removeHolidaysFromGroup),
    studentGroupController.removeHolidays
  );

router
  .route('/:groupId')
  .get(
    auth(),
    requireAttendanceAssign,
    validate(studentGroupValidation.getStudentGroup),
    studentGroupController.get
  )
  .patch(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.updateStudentGroup),
    studentGroupController.update
  )
  .delete(
    auth(),
    requireStudentsManage,
    validate(studentGroupValidation.getStudentGroup),
    studentGroupController.remove
  );

export default router;
