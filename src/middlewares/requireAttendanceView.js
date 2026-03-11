/**
 * Allow access to attendance view (track list, history) for:
 * - Users with students.read or students.manage (admins, managers)
 * - Any authenticated non-admin user (Candidate, Agent, Student, etc.)
 * This loosens the criteria so candidates and agents can view and fill attendance.
 */
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import Role from '../models/role.model.js';

const requireAttendanceView = async (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  const granting = getGrantingPermissions('students.read').concat(getGrantingPermissions('students.manage'));
  const permissions = req.authContext?.permissions;
  if (permissions && granting.some((p) => permissions.has(p))) {
    return next();
  }

  const userId = req.user.id || req.user._id?.toString?.();
  const userDoc = req.user;
  let isAdmin = userDoc.role === 'admin' || userDoc.role === 'Administrator';
  if (!isAdmin && (userDoc.roleIds || []).length > 0) {
    const adminRoles = await Role.find({ name: { $in: ['admin', 'Administrator'] }, status: 'active' }).select('_id').lean();
    const adminIds = new Set(adminRoles.map((r) => r._id.toString()));
    isAdmin = (userDoc.roleIds || []).some((id) => id && adminIds.has(id.toString()));
  }
  if (!isAdmin) {
    return next();
  }

  return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to view attendance'));
};

export default requireAttendanceView;
