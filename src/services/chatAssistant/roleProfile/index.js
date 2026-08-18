// Role profile resolver — returns real Role schema fields + assigned user count.

import RoleModel from '../../../models/role.model.js';
import UserModel from '../../../models/user.model.js';
import { resolveRole as realResolveRole } from '../roleRegistry.js';
import { visibleUserStatusClause } from '../visibilityRules.js';
import { renderRoleProfile as renderRoleProfileNatural } from '../conversationPolicy/renderFacts.js';

/**
 * @param {object} role lean Role doc
 */
export function serializeRoleFields(role) {
  if (!role) return {};
  return {
    name: role.name ?? null,
    slug: role.slug ?? null,
    aliases: Array.isArray(role.aliases) ? role.aliases : [],
    previousNames: Array.isArray(role.previousNames)
      ? role.previousNames.map((p) => ({ name: p?.name ?? null, renamedAt: p?.renamedAt ?? null }))
      : [],
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    status: role.status ?? null,
    createdAt: role.createdAt ?? null,
    updatedAt: role.updatedAt ?? null,
  };
}

/**
 * @param {object} a
 * @param {string} [a.roleName]
 * @param {any} [a.roleId]
 * @param {object} [a.viewer]
 * @param {object} [a.deps]
 */
export async function resolveRoleProfile({
  roleName = null,
  roleId = null,
  deps = {},
}) {
  const Role = deps.Role ?? RoleModel;
  const User = deps.User ?? UserModel;
  const resolveRole = deps.resolveRole ?? realResolveRole;

  let role = null;
  if (roleId) {
    role = await Role.findById(roleId).lean();
  } else if (roleName) {
    const r = await resolveRole(roleName);
    if (r.ids?.[0]) {
      role = await Role.findById(r.ids[0]).lean();
    }
  }

  if (!role) return { kind: 'notFound', entityType: 'role' };

  const assignedCount = await User.countDocuments({
    roleIds: role._id,
    status: visibleUserStatusClause(),
  });

  const assignedUsers = assignedCount
    ? await User.find({ roleIds: role._id, status: visibleUserStatusClause() })
        .select('name email')
        .sort({ name: 1 })
        .limit(10)
        .lean()
    : [];

  return {
    kind: 'unique',
    entityType: 'role',
    role: serializeRoleFields(role),
    roleId: role._id,
    assignedCount,
    assignedUsers: assignedUsers.map((u) => ({
      userId: u._id,
      name: u.name,
      email: u.email ?? null,
    })),
  };
}

export function renderRoleProfileReply(profile) {
  return renderRoleProfileNatural(profile);
}
