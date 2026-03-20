import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import Student from '../models/student.model.js';
import Candidate from '../models/candidate.model.js';

/**
 * Require that the current user is either the student owner (student.user === req.user.id)
 * or has permission to manage/read students (e.g. admin).
 * Must be used after auth(). Student ID is taken from req.params (set by route) or parsed from req.path
 * when this middleware runs via router.use() (before route matching, so params may be empty).
 */
const requireAttendanceAccess = async (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  let studentId = req.params.studentId;
  if (!studentId && req.path) {
    const segments = req.path.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const last = segments[segments.length - 1];
      const validPrefixes = ['status', 'student', 'statistics', 'punch-in', 'punch-out'];
      if (validPrefixes.includes(segments[0]) && last && last.length === 24) {
        studentId = last;
      }
    }
  }
  if (!studentId) {
    return next(new ApiError(httpStatus.BAD_REQUEST, 'Student ID required'));
  }
  req.params.studentId = studentId;

  const student = await Student.findById(studentId).select('user').lean();
  if (!student) {
    return next(new ApiError(httpStatus.NOT_FOUND, 'Student not found'));
  }

  const userId = req.user.id || req.user._id?.toString?.();
  const studentUserId = student.user?.toString?.();
  if (userId && studentUserId && userId === studentUserId) {
    return next();
  }

  const granting = getGrantingPermissions('students.read').concat(getGrantingPermissions('students.manage'));
  const permissions = req.authContext?.permissions;
  if (permissions && granting.some((p) => permissions.has(p))) {
    return next();
  }

  /**
   * Align with GET /candidates/:candidateId/attendance (requireCandidateAttendanceList):
   * users with candidates.read / candidates.manage may view attendance for the Student profile
   * whose user is the candidate owner — same person, without requiring students.read.
   */
  if (permissions && studentUserId) {
    const grantingCandidates = getGrantingPermissions('candidates.read').concat(
      getGrantingPermissions('candidates.manage')
    );
    if (grantingCandidates.some((p) => permissions.has(p))) {
      const linkedCandidate = await Candidate.findOne({ owner: studentUserId }).select('_id').lean();
      if (linkedCandidate) {
        return next();
      }
    }
  }

  return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to access this student\'s attendance'));
};

export default requireAttendanceAccess;
