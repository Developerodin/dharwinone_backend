import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import requirePermissions, { requireAnyOfPermissions } from './requirePermissions.js';

/**
 * Like requirePermissions(perm), but also allows the named Administrator role (and platform super)
 * for routes that were previously `requireUsersManageOrAdministrator`—style gates.
 * @param {string} requiredPermission
 */
export const requirePermissionOrAdministrator = (requiredPermission) => {
  return async (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }
    if (req.user.platformSuperUser) return next();
    try {
      if (await userIsAdmin(req.user)) return next();
    } catch (e) {
      return next(e);
    }
    return requirePermissions(requiredPermission)(req, res, next);
  };
};

/**
 * Like requireAnyOfPermissions(...perms), but also allows the named Administrator role (and platform super).
 * @param  {...string} requiredPermissions
 */
export const requireAnyOfPermissionsOrAdministrator = (...requiredPermissions) => {
  return async (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }
    if (req.user.platformSuperUser) return next();
    try {
      if (await userIsAdmin(req.user)) return next();
    } catch (e) {
      return next(e);
    }
    return requireAnyOfPermissions(...requiredPermissions)(req, res, next);
  };
};
