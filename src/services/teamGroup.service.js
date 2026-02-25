import httpStatus from 'http-status';
import TeamGroup from '../models/teamGroup.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

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
  delete filter.userRoleIds;
  delete filter.userId;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  let finalFilter = { ...filter };
  if (!isAdmin && userId) {
    finalFilter = { $and: [finalFilter, { createdBy: userId }] };
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
