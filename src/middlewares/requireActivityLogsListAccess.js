import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import { getGrantingPermissions } from '../config/permissions.js';

/**
 * GET /activity-logs list gate: allow designated platform email, platform super user, or any
 * user holding the view permission (activityLogs.read / activity.read). The controller
 * (resolveActivityLogListFilter) scopes non-privileged viewers to their own logs, so this
 * middleware no longer requires an `actor=<own id>` query param.
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
