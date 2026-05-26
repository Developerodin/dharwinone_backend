import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Role from '../models/role.model.js';
import { getGrantingPermissions } from '../config/permissions.js';

/**
 * @param {string} requiredPermission - API-derived permission key (e.g. 'users.impersonate')
 * @param {string|string[]} [roleName='Administrator'] - role name(s) that bypass the permission check
 */
const requireAdministratorOrPermission = (requiredPermission, roleName = 'Administrator') => async (req, res, next) => {
  if (!req.user || !req.authContext) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
  if (req.user.platformSuperUser) return next();

  const bypassRoles = Array.isArray(roleName) ? roleName : [roleName];
  const roleIds = req.user.roleIds || [];
  if (roleIds.length > 0 && bypassRoles.length > 0) {
    const hasBypassRole = await Role.exists({ _id: { $in: roleIds }, name: { $in: bypassRoles }, status: 'active' });
    if (hasBypassRole) return next();
  }

  const { permissions } = req.authContext;
  const granting = getGrantingPermissions(requiredPermission);
  if (granting.some((p) => permissions.has(p))) return next();

  return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
};

export default requireAdministratorOrPermission;
