import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Sprint from '../models/sprint.model.js';
import Project from '../models/project.model.js';
import Task from '../models/task.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { hasApiPermission } from '../utils/permissionCheck.js';

const SPRINT_LIST_LIMIT_MAX = 200;
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const canManageSprint = async (user, resource) => {
  if (!resource || !user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  if (String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id)) return true;
  return hasApiPermission(user, 'tasks.manage');
};

const assertProjectExists = async (projectId) => {
  if (!projectId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'projectId is required');
  }
  const project = await Project.findById(projectId).select('_id').lean();
  if (!project) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Project not found');
  }
};

const createSprint = async (createdById, payload) => {
  await assertProjectExists(payload.projectId);
  const sprint = await Sprint.create({
    createdBy: createdById,
    ...payload,
  });
  await sprint.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
  ]);
  return sprint;
};

const querySprints = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(escapeRegex(filter.search), 'i');
    filter.$or = [{ name: searchRegex }, { goal: searchRegex }];
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const apiPermissions = filter.apiPermissions instanceof Set ? filter.apiPermissions : new Set();
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.apiPermissions;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  const canSeeAll = isAdmin || apiPermissions.has('tasks.read') || apiPermissions.has('tasks.manage');
  let finalFilter = { ...filter };

  if (!canSeeAll && userId) {
    finalFilter = {
      $and: [
        finalFilter,
        { $or: [{ createdBy: userId }] },
      ],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit =
    options.limit && parseInt(options.limit, 10) > 0
      ? Math.min(SPRINT_LIST_LIMIT_MAX, parseInt(options.limit, 10))
      : 100;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    Sprint.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'createdBy', select: 'name email' },
        { path: 'projectId', select: 'name' },
      ])
      .exec(),
    Sprint.countDocuments(finalFilter).exec(),
  ]);

  const totalPages = Math.ceil(totalResults / limit);
  return { results, page, limit, totalPages, totalResults };
};

const getSprintById = async (id) => {
  const sprint = await Sprint.findById(id).exec();
  if (!sprint) return null;
  await sprint.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
  ]);
  return sprint;
};

const updateSprintById = async (id, updateBody, currentUser) => {
  const sprint = await getSprintById(id);
  if (!sprint) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Sprint not found');
  }
  const canUpdate = await canManageSprint(currentUser, sprint);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  if (updateBody.projectId) {
    await assertProjectExists(updateBody.projectId);
    const taskCount = await Task.countDocuments({ sprintId: sprint._id });
    if (taskCount > 0 && String(updateBody.projectId) !== String(sprint.projectId?._id || sprint.projectId)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Cannot move sprint to another project while tasks are assigned to it'
      );
    }
  }
  Object.assign(sprint, updateBody);
  await sprint.save();
  await sprint.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
  ]);
  return sprint;
};

const deleteSprintById = async (id, currentUser) => {
  const sprint = await getSprintById(id);
  if (!sprint) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Sprint not found');
  }
  const canDelete = await canManageSprint(currentUser, sprint);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  await sprint.deleteOne();
  return sprint;
};

export {
  createSprint,
  querySprints,
  getSprintById,
  updateSprintById,
  deleteSprintById,
  isOwnerOrAdmin,
  canManageSprint,
};
