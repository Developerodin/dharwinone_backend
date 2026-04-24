import httpStatus from 'http-status';

import ApiError from '../utils/ApiError.js';
import Role from '../models/role.model.js';
import User from '../models/user.model.js';

/**
 * Create a role
 * @param {Object} roleBody
 * @returns {Promise<Role>}
 */
const createRole = async (roleBody) => {
  if (await Role.isNameTaken(roleBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Role name already taken');
  }
  return Role.create(roleBody);
};

/**
 * Query for roles
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
/**
 * Per-role user counts for the roles list. "Active/pending" matches ATS candidate owner scope (see getOwnerIdsWithCandidateRole).
 * @param {import('mongoose').Document[]} roleDocs
 * @returns {Promise<Record<string, { assigneeCountTotal: number, assigneeCountActivePending: number }>>}
 */
const getAssigneeCountsByRoleId = async (roleDocs) => {
  if (!roleDocs?.length) return {};
  const ids = roleDocs.map((r) => r._id).filter(Boolean);
  if (ids.length === 0) return {};

  const [totals, activePending] = await Promise.all([
    User.aggregate([
      { $match: { roleIds: { $in: ids } } },
      { $unwind: '$roleIds' },
      { $match: { roleIds: { $in: ids } } },
      { $group: { _id: '$roleIds', count: { $sum: 1 } } },
    ]),
    User.aggregate([
      {
        $match: {
          roleIds: { $in: ids },
          status: { $in: ['active', 'pending'] },
        },
      },
      { $unwind: '$roleIds' },
      {
        $match: {
          roleIds: { $in: ids },
          status: { $in: ['active', 'pending'] },
        },
      },
      { $group: { _id: '$roleIds', count: { $sum: 1 } } },
    ]),
  ]);

  const out = {};
  for (const id of ids) {
    const s = String(id);
    out[s] = { assigneeCountTotal: 0, assigneeCountActivePending: 0 };
  }
  for (const row of totals) {
    const s = String(row._id);
    if (out[s]) out[s].assigneeCountTotal = row.count;
  }
  for (const row of activePending) {
    const s = String(row._id);
    if (out[s]) out[s].assigneeCountActivePending = row.count;
  }
  return out;
};

const queryRoles = async (filter, options) => {
  const roles = await Role.paginate(filter, options);
  const countById = await getAssigneeCountsByRoleId(roles.results || []);
  roles.results = (roles.results || []).map((doc) => {
    const id = String(doc._id);
    const json = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };
    const c = countById[id] || { assigneeCountTotal: 0, assigneeCountActivePending: 0 };
    return {
      ...json,
      assigneeCountTotal: c.assigneeCountTotal,
      assigneeCountActivePending: c.assigneeCountActivePending,
    };
  });
  return roles;
};

/**
 * Get role by id
 * @param {ObjectId} roleId
 * @returns {Promise<Role>}
 */
const getRoleById = async (roleId) => {
  return Role.findById(roleId);
};

/**
 * Get role by name (case-insensitive)
 * @param {string} name
 * @returns {Promise<Role>}
 */
const getRoleByName = async (name) => {
  return Role.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
};

/** Preferred user-role name; legacy deploys may still have "Candidate" until migration. */
const EMPLOYEE_ROLE_NAME_ALIASES = ['Employee', 'Candidate'];

/**
 * The ATS employee / job-seeker user role (renamed from Candidate to Employee).
 * Tries "Employee" first, then "Candidate" for backward compatibility.
 * @returns {Promise<import('mongoose').Document|null>}
 */
const getEmployeeRole = async () => {
  for (const name of EMPLOYEE_ROLE_NAME_ALIASES) {
    const r = await getRoleByName(name);
    if (r) return r;
  }
  return null;
};

/**
 * User ids that own ATS candidate profiles: users with the Employee (or legacy Candidate) role (active or pending).
 * Supports multi-role users (role id in roleIds array).
 * @returns {Promise<import('mongoose').Types.ObjectId[]|null>} null if no employee role document exists; otherwise id list (may be empty)
 */
const getOwnerIdsWithCandidateRole = async () => {
  const employeeRole = await getEmployeeRole();
  if (!employeeRole) return null;
  const users = await User.find(
    { roleIds: employeeRole._id, status: { $in: ['active', 'pending'] } },
    { _id: 1 }
  ).lean();
  return users.map((u) => u._id);
};

/**
 * Update role by id
 * @param {ObjectId} roleId
 * @param {Object} updateBody
 * @returns {Promise<Role>}
 */
const updateRoleById = async (roleId, updateBody) => {
  const role = await getRoleById(roleId);
  if (!role) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Role not found');
  }
  if (updateBody.name && (await Role.isNameTaken(updateBody.name, roleId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Role name already taken');
  }
  Object.assign(role, updateBody);
  await role.save();
  return role;
};

/**
 * Delete role by id
 * @param {ObjectId} roleId
 * @returns {Promise<Role>}
 */
/** Max display names stored on role.update audit rows (avoids huge metadata). */
const ROLE_UPDATE_MEMBER_NAMES_LIMIT = 40;

/**
 * Snapshot of users assigned to a role (for activity log at role update time).
 * @param {import('mongoose').Types.ObjectId|string} roleId
 * @returns {Promise<{ roleMemberDisplayNames: string[], roleMemberCount: number, roleMemberNamesTruncated?: boolean }>}
 */
const getRoleAssigneeDisplaySnapshot = async (roleId) => {
  const [roleMemberCount, users] = await Promise.all([
    User.countDocuments({ roleIds: roleId }),
    User.find({ roleIds: roleId })
      .select('name username email')
      .sort({ name: 1 })
      .limit(ROLE_UPDATE_MEMBER_NAMES_LIMIT)
      .lean(),
  ]);
  const roleMemberDisplayNames = users
    .map((u) => {
      const name = u.name != null ? String(u.name).trim() : '';
      const username = u.username != null ? String(u.username).trim() : '';
      const email = u.email != null ? String(u.email).trim() : '';
      return name || username || email || '';
    })
    .filter(Boolean);
  const out = { roleMemberDisplayNames, roleMemberCount };
  if (roleMemberCount > ROLE_UPDATE_MEMBER_NAMES_LIMIT) {
    out.roleMemberNamesTruncated = true;
  }
  return out;
};

const deleteRoleById = async (roleId) => {
  const role = await getRoleById(roleId);
  if (!role) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Role not found');
  }

  // Prevent deleting roles that are currently assigned to active users
  const isAssignedToActiveUser = await User.exists({ roleIds: roleId, status: 'active' });
  if (isAssignedToActiveUser) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Role cannot be deleted because it is assigned to one or more active users'
    );
  }

  await role.deleteOne();
  return role;
};

export {
  createRole,
  queryRoles,
  getRoleById,
  getRoleByName,
  getEmployeeRole,
  getOwnerIdsWithCandidateRole,
  updateRoleById,
  deleteRoleById,
  getRoleAssigneeDisplaySnapshot,
};
