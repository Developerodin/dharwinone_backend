import Role from '../models/role.model.js';

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
 * Build permission context for a user based on their roleIds.
 * - Roles contribute domain permissions, which are mapped to API permissions.
 *
 * @param {import('../models/user.model.js').default} user
 * @returns {Promise<{ isAdmin: boolean, permissions: Set<string> }>}
 */
const getUserPermissionContext = async (user) => {
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) {
    return { isAdmin: false, permissions: new Set() }; // isAdmin kept for future extensibility
  }

  const roles = await Role.find({ _id: { $in: roleIds }, status: 'active' }).lean();
  if (!roles.length) {
    return { isAdmin: false, permissions: new Set() };
  }

  // Collect raw domain permissions from all roles
  const rawPermissions = new Set();
  for (const role of roles) {
    if (!role.permissions || !Array.isArray(role.permissions)) continue;
    for (const p of role.permissions) {
      if (typeof p === 'string' && p.trim()) {
        rawPermissions.add(p.trim());
      }
    }
  }

  const apiPermissions = deriveApiPermissions(rawPermissions);

  return { isAdmin: false, permissions: apiPermissions };
};

export { getUserPermissionContext };
