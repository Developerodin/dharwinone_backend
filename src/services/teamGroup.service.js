import httpStatus from 'http-status';
import TeamGroup from '../models/teamGroup.model.js';
import TeamMember from '../models/team.model.js';
import Project from '../models/project.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createTeamGroup = async (createdById, payload) => {
  const team = await TeamGroup.create({
    createdBy: createdById,
    ...payload,
  });
  await team.populate([{ path: 'createdBy', select: 'name email' }]);
  return team;
};

const queryTeamGroups = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    filter.name = searchRegex;
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const userEmail = filter.userEmail;
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.userEmail;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  let finalFilter = { ...filter };
  /** Teams created by someone else still appear if the user is on that team's roster (email match). */
  if (!isAdmin && userId) {
    const uemail = String(userEmail || '').trim();
    let teamIdsImOn = [];
    if (uemail) {
      teamIdsImOn = await TeamMember.distinct('teamId', {
        teamId: { $ne: null },
        email: new RegExp(`^${escapeRegex(uemail)}$`, 'i'),
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
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 100;
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
  const canUpdate = await isOwnerOrAdmin(currentUser, team);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
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
  const canDelete = await isOwnerOrAdmin(currentUser, team);
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
  getTeamGroupById,
  updateTeamGroupById,
  deleteTeamGroupById,
};
