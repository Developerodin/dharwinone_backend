import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';

/**
 * When the request is authenticated, require at least one of the given permissions.
 * Unauthenticated requests pass through (for public self-registration flows).
 * Must run after optionalAuth() so req.user / req.authContext are set when a token is present.
 */
const requirePermissionIfAuthenticated =
  (...requiredPermissions) =>
  async (req, res, next) => {
    if (!req.user) {
      return next();
    }

    if (req.user.platformSuperUser) {
      return next();
    }

    if (!req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }

    const { permissions } = req.authContext;
    const allowed = requiredPermissions.some((required) => {
      const granting = getGrantingPermissions(required);
      return granting.some((p) => permissions.has(p));
    });

    if (!allowed) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'Forbidden'));
    }

    return next();
  };

export default requirePermissionIfAuthenticated;
