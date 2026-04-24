import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import Employee from '../models/employee.model.js';

/**
 * Allows listing user-based attendance (Attendance.user) for another user when:
 * - the viewer is that user, or
 * - the viewer has students.read / students.manage, or
 * - the viewer has candidates.read / candidates.manage AND a Candidate exists with owner = target user
 *   (ATS staff viewing a candidate who punches as an agent without a Student profile).
 */
const requireUserAttendanceView = async (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  const targetUserId = req.params.userId;
  if (!targetUserId) {
    return next(new ApiError(httpStatus.BAD_REQUEST, 'User ID required'));
  }

  const userId = req.user.id || req.user._id?.toString?.();
  if (userId && targetUserId === userId) {
    return next();
  }

  const permissions = req.authContext?.permissions;
  const grantingStudents = getGrantingPermissions('students.read').concat(getGrantingPermissions('students.manage'));
  if (permissions && grantingStudents.some((p) => permissions.has(p))) {
    return next();
  }

  const grantingCandidates = getGrantingPermissions('candidates.read').concat(getGrantingPermissions('candidates.manage'));
  if (permissions && grantingCandidates.some((p) => permissions.has(p))) {
    const candidate = await Employee.findOne({ owner: targetUserId }).select('_id').lean();
    if (candidate) {
      return next();
    }
  }

  return next(new ApiError(httpStatus.FORBIDDEN, "You do not have permission to access this user's attendance"));
};

export default requireUserAttendanceView;
