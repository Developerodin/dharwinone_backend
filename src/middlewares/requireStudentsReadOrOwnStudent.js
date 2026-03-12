import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import Student from '../models/student.model.js';

/**
 * Allow GET student if user has students.read OR if the student belongs to the current user.
 * Used so candidates/students can view their own student profile (including shift) in attendance tracking.
 */
const requireStudentsReadOrOwnStudent = async (req, res, next) => {
  if (!req.user || !req.authContext) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  const { permissions } = req.authContext;
  const granting = getGrantingPermissions('students.read');
  const hasStudentsRead = granting.some((p) => permissions.has(p));
  if (hasStudentsRead) {
    return next();
  }

  const studentId = req.params.studentId;
  if (!studentId) {
    return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
  }

  try {
    const student = await Student.findById(studentId).select('user').lean();
    if (!student) {
      return next(new ApiError(httpStatus.NOT_FOUND, 'Student not found'));
    }
    const studentUserId = student.user?.toString?.();
    if (studentUserId === req.user.id) {
      return next();
    }
  } catch (err) {
    return next(err);
  }

  return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to view this student'));
};

export default requireStudentsReadOrOwnStudent;
