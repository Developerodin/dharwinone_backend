import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import { getGrantingPermissions } from '../config/permissions.js';

/**
 * GET /activity-logs list: designated platform email, platform super user, users with
 * activityLogs.read / activity.read, or self-actor query (actor === own user id).
 */
const requireActivityLogsListAccess = (req, res, next) => {
  if (!req.user || !req.authContext) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
  if (config.isDesignatedSuperadminEmail(req.user.email)) {
    return next();
  }
  if (req.user.platformSuperUser) {
    return next();
  }
  const { permissions } = req.authContext;
  const granting = getGrantingPermissions('activityLogs.read');
  if (granting.some((p) => permissions.has(p))) {
    return next();
  }
  return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to view activity logs'));
};

export default requireActivityLogsListAccess;
