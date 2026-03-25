import Role from '../models/role.model.js';
import User from '../models/user.model.js';

/**
 * Derive API permissions from raw domain permissions using a single rule:
 * - Permission format: "category.resource:view,create,edit,delete" (e.g. "settings.users:view,create,edit,delete").
 * - Rule: use the part after the first dot as the API resource name, then add .read / .manage.
 * - So "settings.users:view,..." → users.read (+ users.manage if create/edit/delete).
 * - So "settings.roles:view,..." → roles.read, roles.manage.
 * - So "ats.jobs:view,..." → jobs.read, jobs.manage.
 * - So "logs.activity:view,..." → activity.read, activity.manage.
 *
 * No hardcoded mapping table: any new permission string follows the same rule, so new APIs
 * and frontend nav links stay in sync (resource name = part after first dot).
 *
 * @param {Set<string>} rawPermissions
 * @returns {Set<string>}
 */
const deriveApiPermissions = (rawPermissions) => {
  const apiPermissions = new Set();

  for (const raw of rawPermissions) {
    const [key, actionsPart] = raw.split(':');
    if (!key || !actionsPart) continue;

    // Resource = part after the first dot (e.g. "settings.users" → "users", "ats.jobs" → "jobs")
    const dotIndex = key.indexOf('.');
    const resource = dotIndex >= 0 ? key.substring(dotIndex + 1).trim() : key.trim();
    if (!resource) continue;

    const actions = actionsPart.split(',').map((a) => a.trim().toLowerCase());
    if (actions.includes('view')) {
      apiPermissions.add(`${resource}.read`);
    }
    if (actions.some((a) => ['create', 'edit', 'delete'].includes(a))) {
      apiPermissions.add(`${resource}.manage`);
    }
  }

  return apiPermissions;
};

/**
 * @param {Array<{ permissions?: string[] }>} roles
 * @returns {Set<string>}
 */
const collectRawPermissionsFromRoles = (roles) => {
  const rawPermissions = new Set();
  for (const role of roles) {
    if (!role.permissions || !Array.isArray(role.permissions)) continue;
    for (const p of role.permissions) {
      if (typeof p === 'string' && p.trim()) {
        rawPermissions.add(p.trim());
      }
    }
  }
  return rawPermissions;
};

/**
 * Union of every active role's domain permission strings (for platform super users).
 * @returns {Promise<Set<string>>}
 */
const getAllActiveRolesRawPermissions = async () => {
  const roles = await Role.find({ status: 'active' }).lean();
  return collectRawPermissionsFromRoles(roles);
};

/**
 * Build permission context for a user based on their roleIds.
 * - Roles contribute domain permissions, which are mapped to API permissions.
 *
 * @param {import('../models/user.model.js').default} user
 * @returns {Promise<{ isAdmin: boolean, permissions: Set<string> }>}
 */
const getUserPermissionContext = async (user) => {
  if (user?.platformSuperUser) {
    const rawPermissions = await getAllActiveRolesRawPermissions();
    const apiPermissions = deriveApiPermissions(rawPermissions);
    return { isAdmin: true, permissions: apiPermissions };
  }

  const roleIds = user?.roleIds || [];
  if (!roleIds.length) {
    return { isAdmin: false, permissions: new Set() }; // isAdmin kept for future extensibility
  }

  const roles = await Role.find({ _id: { $in: roleIds }, status: 'active' }).lean();
  if (!roles.length) {
    return { isAdmin: false, permissions: new Set() };
  }

  // Collect raw domain permissions from all roles
  const rawPermissions = collectRawPermissionsFromRoles(roles);
  const apiPermissions = deriveApiPermissions(rawPermissions);

  return { isAdmin: false, permissions: apiPermissions };
};

/**
 * Returns the current user's permissions for frontend use (raw domain format).
 * Used by GET /auth/my-permissions to avoid requiring roles.read to list roles.
 *
 * @param {import('../models/user.model.js').default} user
 * @returns {Promise<{ permissions: string[], roleNames: string[], isAdministrator: boolean }>}
 */
const getMyPermissionsForFrontend = async (user) => {
  if (user?.platformSuperUser) {
    const rawPermissions = await getAllActiveRolesRawPermissions();
    const roleIds = user?.roleIds || [];
    const myRoles = roleIds.length
      ? await Role.find({ _id: { $in: roleIds }, status: 'active' }).lean()
      : [];
    const roleNames = myRoles.map((r) => r.name);
    return {
      permissions: Array.from(rawPermissions),
      roleNames,
      isAdministrator: true,
      isPlatformSuperUser: true,
    };
  }

  const roleIds = user?.roleIds || [];
  if (!roleIds.length) {
    return { permissions: [], roleNames: [], isAdministrator: false, isPlatformSuperUser: false };
  }

  const roles = await Role.find({ _id: { $in: roleIds }, status: 'active' }).lean();
  if (!roles.length) {
    return { permissions: [], roleNames: [], isAdministrator: false, isPlatformSuperUser: false };
  }

  const rawPermissions = collectRawPermissionsFromRoles(roles);
  const roleNames = roles.map((r) => r.name);
  const isAdministrator = roles.some((r) => r.name === 'Administrator');

  return {
    permissions: Array.from(rawPermissions),
    roleNames,
    isAdministrator,
    isPlatformSuperUser: false,
  };
};

/**
 * User IDs for in-app alerts that should reach everyone who can manage ATS candidates.
 * Includes platform super users and users with any active role whose permissions derive `apiPermissionKey`
 * (e.g. `candidates.manage` from `ats.candidates:view,create,edit,delete`).
 *
 * @param {string} apiPermissionKey
 * @returns {Promise<string[]>}
 */
const getUserIdsWithApiPermission = async (apiPermissionKey) => {
  const ids = new Set();

  const supers = await User.find({
    platformSuperUser: true,
    status: { $in: ['active', 'pending'] },
  })
    .select('_id')
    .lean();
  for (const u of supers) ids.add(String(u._id));

  const roles = await Role.find({ status: 'active' }).lean();
  const roleIdsWithPerm = [];
  for (const role of roles) {
    const api = deriveApiPermissions(collectRawPermissionsFromRoles([role]));
    if (api.has(apiPermissionKey)) {
      roleIdsWithPerm.push(role._id);
    }
  }

  if (roleIdsWithPerm.length > 0) {
    const users = await User.find({
      roleIds: { $in: roleIdsWithPerm },
      status: { $in: ['active', 'pending'] },
    })
      .select('_id')
      .lean();
    for (const u of users) ids.add(String(u._id));
  }

  return [...ids];
};

export { getUserPermissionContext, getMyPermissionsForFrontend, getUserIdsWithApiPermission };

