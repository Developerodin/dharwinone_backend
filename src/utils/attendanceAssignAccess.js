import { getGrantingPermissions } from '../config/permissions.js';
import { getUserPermissionContext } from '../services/permission.service.js';
import { userIsAdminOrAgent } from './roleHelpers.js';

async function resolveUserPermissions(user) {
  if (user?.authContext?.permissions instanceof Set) {
    return user.authContext.permissions;
  }
  return (await getUserPermissionContext(user)).permissions;
}

/**
 * Strict `attendance.assign` — permission grants only (plus platform super user).
 * Matches `requirePermissions('attendance.assign')` / leave approve-reject routes; no role-name fallback.
 */
export async function userHasStrictAttendanceAssign(user) {
  if (user?.platformSuperUser) return true;
  const permissions = await resolveUserPermissions(user);
  return getGrantingPermissions('attendance.assign').some((p) => permissions.has(p));
}

/**
 * Matches route guard `attendance.assign` (students.manage OR attendance.manage) with a
 * legacy fallback for sparse matrices that still rely on Administrator/Agent role names.
 */
export async function userHasAttendanceAssign(user) {
  if (await userHasStrictAttendanceAssign(user)) return true;
  return userIsAdminOrAgent(user);
}
