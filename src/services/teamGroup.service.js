import httpStatus from 'http-status';
import TeamGroup from '../models/teamGroup.model.js';
import Position from '../models/position.model.js';
import TeamMember from '../models/team.model.js';
import Employee from '../models/employee.model.js';
import Project from '../models/project.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { hasApiPermission } from '../utils/permissionCheck.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEAM_GROUP_LIST_LIMIT_MAX = 200;

/**
 * Teams the authenticated user belongs to (TeamMember roster), without teams.read.
 * Membership is resolved via Employee.owner → TeamMember.employeeId, with email /
 * legacyEmail fallbacks for pre-migration and orphan rows.
 *
 * @param {{ id?: string, _id?: string, email?: string }} user
 * @returns {Promise<{ results: Array<{ id: string, _id: string, name: string }>, totalResults: number }>}
 */
const listMyTeamGroups = async (user) => {
  const userId = user?.id || user?._id;
  if (!userId) {
    return { results: [], totalResults: 0 };
  }

  const employee = await Employee.findOne({ owner: userId })
    .select('_id email companyAssignedEmail')
    .lean()
    .exec();

  const membershipOr = [];
  if (employee?._id) {
    membershipOr.push({ employeeId: employee._id });
  }

  const emails = [
    user?.email,
    employee?.email,
    employee?.companyAssignedEmail,
  ]
    .map((e) => String(e || '').trim())
    .filter(Boolean);
  for (const email of [...new Set(emails.map((e) => e.toLowerCase()))]) {
    const re = new RegExp(`^${escapeRegex(email)}$`, 'i');
    membershipOr.push({ email: re }, { legacyEmail: re });
  }

  if (membershipOr.length === 0) {
    return { results: [], totalResults: 0 };
  }

  const teamIds = await TeamMember.distinct('teamId', {
    teamId: { $ne: null },
    isActive: { $ne: false },
    $or: membershipOr,
  }).exec();

  const validIds = (teamIds || []).filter((id) => id != null);
  if (validIds.length === 0) {
    return { results: [], totalResults: 0 };
  }

  const teams = await TeamGroup.find({ _id: { $in: validIds } })
    .sort({ name: 1 })
    .select('name')
    .lean()
    .exec();

  const results = teams.map((t) => ({
    id: String(t._id),
    _id: String(t._id),
    name: t.name,
  }));

  return { results, totalResults: results.length };
};

/**
 * @param {Array<string>} requestedIds
 * @param {Array<string>} foundIds
 * @returns {Array<string>} requested ids not present in foundIds
 */
export const findMissingPositionIds = (requestedIds, foundIds) => {
  const found = new Set((foundIds || []).map(String));
  return (requestedIds || []).map(String).filter((id) => !found.has(id));
};

/** Throws ApiError if any relatedPositions id does not resolve to a Position. */
const assertRelatedPositionsExist = async (ids) => {
  if (!ids || !ids.length) return;
  const found = await Position.find({ _id: { $in: ids } }).distinct('_id');
  const missing = findMissingPositionIds(ids, found);
  if (missing.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `TEAM_RELATED_POSITION_NOT_FOUND: ${missing.join(', ')}`);
  }
};

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

/**
 * Authoritative manage gate: platform super, owner, Administrator, or any active
 * role granting teams.manage. Honours route-level permission guard.
 */
const canManageTeamGroup = async (user, resource) => {
  if (!resource || !user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  if (String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id)) return true;
  return hasApiPermission(user, 'teams.manage');
};

const createTeamGroup = async (createdById, payload) => {
  await assertRelatedPositionsExist(payload.relatedPositions);
  const team = await TeamGroup.create({
    createdBy: createdById,
    ...payload,
  });
  await team.populate([{ path: 'createdBy', select: 'name email' }]);
  return team;
};

const queryTeamGroups = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(escapeRegex(filter.search), 'i');
    filter.name = searchRegex;
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const userEmail = filter.userEmail;
  const apiPermissions = filter.apiPermissions instanceof Set ? filter.apiPermissions : new Set();
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.userEmail;
  delete filter.apiPermissions;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  /** Org-wide list when admin OR role grants teams.read / teams.manage. */
  const canSeeAll = isAdmin || apiPermissions.has('teams.read') || apiPermissions.has('teams.manage');
  let finalFilter = { ...filter };
  /** Teams created by someone else still appear if the user is on that team's roster. */
  if (!canSeeAll && userId) {
    const membershipOr = [];
    const employee = await Employee.findOne({ owner: userId }).select('_id email companyAssignedEmail').lean().exec();
    if (employee?._id) membershipOr.push({ employeeId: employee._id });
    const emails = [userEmail, employee?.email, employee?.companyAssignedEmail]
      .map((e) => String(e || '').trim())
      .filter(Boolean);
    for (const email of [...new Set(emails.map((e) => e.toLowerCase()))]) {
      const re = new RegExp(`^${escapeRegex(email)}$`, 'i');
      membershipOr.push({ email: re }, { legacyEmail: re });
    }
    let teamIdsImOn = [];
    if (membershipOr.length) {
      teamIdsImOn = await TeamMember.distinct('teamId', {
        teamId: { $ne: null },
        isActive: { $ne: false },
        $or: membershipOr,
      }).exec();
    }
    finalFilter = {
      $and: [
        finalFilter,
        {
          $or: [
            { createdBy: userId },
            ...(teamIdsImOn.length
              ? [{ _id: { $in: teamIdsImOn.filter((id) => id != null) } }]
              : []),
          ],
        },
      ],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0
    ? Math.min(TEAM_GROUP_LIST_LIMIT_MAX, parseInt(options.limit, 10))
    : 100;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    TeamGroup.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([{ path: 'createdBy', select: 'name email' }])
      .exec(),
    TeamGroup.countDocuments(finalFilter).exec(),
  ]);

  const totalPages = Math.ceil(totalResults / limit);
  return { results, page, limit, totalPages, totalResults };
};

const getTeamGroupById = async (id) => {
  const team = await TeamGroup.findById(id).exec();
  if (!team) return null;
  await team.populate([{ path: 'createdBy', select: 'name email' }]);
  return team;
};

const updateTeamGroupById = async (id, updateBody, currentUser) => {
  const team = await getTeamGroupById(id);
  if (!team) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team not found');
  }
  const canUpdate = await canManageTeamGroup(currentUser, team);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  if (updateBody.relatedPositions !== undefined) {
    await assertRelatedPositionsExist(updateBody.relatedPositions);
  }
  Object.assign(team, updateBody);
  await team.save();
  await team.populate([{ path: 'createdBy', select: 'name email' }]);
  return team;
};

const deleteTeamGroupById = async (id, currentUser) => {
  const team = await getTeamGroupById(id);
  if (!team) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team not found');
  }
  const canDelete = await canManageTeamGroup(currentUser, team);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const teamOid = team._id;
  await TeamMember.deleteMany({ teamId: teamOid }).exec();
  await Project.updateMany({ assignedTeams: teamOid }, { $pull: { assignedTeams: teamOid } }).exec();
  await team.deleteOne();
  return team;
};

export {
  createTeamGroup,
  queryTeamGroups,
  listMyTeamGroups,
  getTeamGroupById,
  updateTeamGroupById,
  deleteTeamGroupById,
};
