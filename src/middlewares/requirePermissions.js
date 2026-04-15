import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';

/**
 * Require one or more permissions for the current request.
 * - Must be used after auth() so req.user and req.authContext are set.
 * - Each required permission is resolved to a list of "granting" permissions (aliases);
 *   the user must have at least one of them (e.g. activityLogs.read is granted by activity.read).
 *
 * @param  {...string} requiredPermissions
 */
const requirePermissions = (...requiredPermissions) => (req, res, next) => {
  if (!req.user || !req.authContext) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  if (req.user.platformSuperUser) {
    return next();
  }

  const { permissions } = req.authContext;

  if (!requiredPermissions.length) {
    return next();
  }

  for (const required of requiredPermissions) {
    const granting = getGrantingPermissions(required);
    const hasAccess = granting.some((p) => permissions.has(p));
    if (!hasAccess) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
    }
  }

  return next();
};

/**
 * User must have at least one of the permissions (each resolved via getGrantingPermissions).
 */
export const requireAnyOfPermissions =
  (...requiredPermissions) =>
  (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }

    if (req.user.platformSuperUser) {
      return next();
    }

    const { permissions } = req.authContext;

    if (!requiredPermissions.length) {
      return next();
    }

    const ok = requiredPermissions.some((required) => {
      const granting = getGrantingPermissions(required);
      return granting.some((p) => permissions.has(p));
    });

    if (!ok) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
    }

    return next();
  };

export default requirePermissions;

