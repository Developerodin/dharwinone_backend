import httpStatus from 'http-status';
import { getGrantingPermissions } from '../config/permissions.js';
import ApiError from '../utils/ApiError.js';

/**
 * users.manage (derived from settings.users) gate.
 *
 * Historical behavior: this middleware ALSO bypassed for the named
 * "Administrator" role. That bypass has been REMOVED per RBAC policy: only
 * super_admin (platformSuperUser) may bypass. Admin must hold `users.manage`
 * (granted by `settings.users:create,edit,delete`) explicitly.
 *
 * Name preserved to avoid mass route rewiring; the "OrAdministrator" suffix
 * is now a legacy label only.
 */
export default async function requireUsersManageOrAdministrator(req, res, next) {
  if (req.user?.platformSuperUser) return next();
  const granting = getGrantingPermissions('users.manage');
  const has = granting.some((p) => req.authContext.permissions.has(p));
  if (has) return next();
  next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
}
