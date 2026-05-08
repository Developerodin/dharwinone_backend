import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import requirePermissions, { requireAnyOfPermissions } from './requirePermissions.js';

/**
 * Permission gate with super_admin bypass.
 *
 * Historical behavior: this middleware ALSO bypassed the gate for the named
 * "Administrator" role. That bypass has been REMOVED per RBAC policy: only
 * super_admin (platformSuperUser) may bypass permission checks. Admin must
 * hold the explicit permission like every other role.
 *
 * The middleware name and signature are preserved so existing routes do not
 * need to be rewired in one go, but the "OrAdministrator" suffix is now a
 * legacy label only — there is no Administrator-named bypass at runtime.
 *
 * @param {string} requiredPermission
 */
export const requirePermissionOrAdministrator = (requiredPermission) => {
  return async (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }
    if (req.user.platformSuperUser) return next();
    return requirePermissions(requiredPermission)(req, res, next);
  };
};

/**
 * Multi-permission variant. Same policy as `requirePermissionOrAdministrator`:
 * super_admin bypasses; the named "Administrator" role does NOT auto-bypass and
 * must hold one of the listed permissions.
 *
 * @param  {...string} requiredPermissions
 */
export const requireAnyOfPermissionsOrAdministrator = (...requiredPermissions) => {
  return async (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }
    if (req.user.platformSuperUser) return next();
    return requireAnyOfPermissions(...requiredPermissions)(req, res, next);
  };
};
