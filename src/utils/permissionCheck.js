import { getUserPermissionContext } from '../services/permission.service.js';
import { getGrantingPermissions } from '../config/permissions.js';
import { resolveActionPermission } from '../config/actionPermissions.js';

/**
 * True if the user has the named API permission via any of their active roles
 * (or is platformSuperUser). Honours alias map in config/permissions.js so
 * callers can check business keys (e.g. 'tasks.manage') rather than raw role
 * permission strings.
 *
 * Prefer {@link hasApiPermissionFromContext} when req.authContext is available
 * (controllers / middleware) — avoids re-querying roles.
 *
 * @param {Object|null|undefined} user
 * @param {string} required - e.g. 'tasks.manage'
 * @returns {Promise<boolean>}
 */
export const hasApiPermission = async (user, required) => {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  const { permissions } = await getUserPermissionContext(user);
  return getGrantingPermissions(required).some((p) => permissions.has(p));
};

/**
 * True only if the user holds EVERY permission in `requiredList` (single role lookup).
 * Use for "full access" gates where a partial action set must NOT qualify —
 * e.g. tenant-wide interview visibility requires read+create+edit+delete, while
 * `interviews.manage` alone is derived from ANY single manage action.
 *
 * @param {Object|null|undefined} user
 * @param {string[]} requiredList - e.g. ['interviews.read', 'interviews.create', 'interviews.edit', 'interviews.delete']
 * @returns {Promise<boolean>}
 */
export const hasAllApiPermissions = async (user, requiredList = []) => {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  const { permissions } = await getUserPermissionContext(user);
  return requiredList.every((required) => getGrantingPermissions(required).some((p) => permissions.has(p)));
};

/**
 * Synchronous variant for routes that have already loaded req.authContext.
 *
 * @param {Set<string>|undefined} apiPermissions - req.authContext?.permissions
 * @param {boolean} platformSuperUser
 * @param {string} required
 * @returns {boolean}
 */
export const hasApiPermissionFromContext = (apiPermissions, platformSuperUser, required) => {
  if (platformSuperUser) return true;
  if (!apiPermissions) return false;
  return getGrantingPermissions(required).some((p) => apiPermissions.has(p));
};

/**
 * Flat semantic-action gate: hasPermission(user, 'assign_task').
 * Resolves the action via {@link ACTION_PERMISSIONS} then delegates to
 * {@link hasApiPermission}. Use this in business logic instead of raw role checks.
 *
 * @param {Object|null|undefined} user
 * @param {string} action - semantic action key (e.g. 'create_project')
 * @returns {Promise<boolean>}
 */
export const hasPermission = async (user, action) => {
  const required = resolveActionPermission(action);
  return hasApiPermission(user, required);
};

/**
 * Synchronous variant when req.authContext is already available.
 *
 * @param {Object} ctx
 * @param {Set<string>|undefined} ctx.apiPermissions
 * @param {boolean} ctx.platformSuperUser
 * @param {string} action
 * @returns {boolean}
 */
export const hasPermissionFromContext = (ctx, action) => {
  const required = resolveActionPermission(action);
  return hasApiPermissionFromContext(ctx?.apiPermissions, !!ctx?.platformSuperUser, required);
};
