import httpStatus from 'http-status';
import TeamMember from '../models/team.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createTeamMember = async (createdById, payload) => {
  const member = await TeamMember.create({
    createdBy: createdById,
    ...payload,
  });
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
  ]);
  return member;
};

const queryTeamMembers = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    filter.$or = [
      { name: searchRegex },
      { email: searchRegex },
      { position: searchRegex },
    ];
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  delete filter.userRoleIds;
  delete filter.userId;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  let finalFilter = { ...filter };
  if (!isAdmin && userId) {
    finalFilter = {
      $and: [finalFilter, { createdBy: userId }],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 100;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    TeamMember.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'createdBy', select: 'name email' },
        { path: 'teamId', select: 'name' },
      ])
      .exec(),
    TeamMember.countDocuments(finalFilter).exec(),
  ]);

  const totalPages = Math.ceil(totalResults / limit);
  return { results, page, limit, totalPages, totalResults };
};

const getTeamMemberById = async (id) => {
  const member = await TeamMember.findById(id).exec();
  if (!member) return null;
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
  ]);
  return member;
};

const updateTeamMemberById = async (id, updateBody, currentUser) => {
  const member = await getTeamMemberById(id);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, member);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  Object.assign(member, updateBody);
  await member.save();
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
  ]);
  return member;
};

const deleteTeamMemberById = async (id, currentUser) => {
  const member = await getTeamMemberById(id);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  const canDelete = await isOwnerOrAdmin(currentUser, member);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  await member.deleteOne();
  return member;
};

export {
  createTeamMember,
  queryTeamMembers,
  getTeamMemberById,
  updateTeamMemberById,
  deleteTeamMemberById,
};

