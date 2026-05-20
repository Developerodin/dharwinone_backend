import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createSprint,
  querySprints,
  getSprintById,
  updateSprintById,
  deleteSprintById,
} from '../services/sprint.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const sprint = await createSprint(createdById, req.body);
  res.status(httpStatus.CREATED).send(sprint);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['projectId', 'status', 'search']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.apiPermissions = req.authContext?.permissions;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await querySprints(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const sprint = await getSprintById(req.params.sprintId);
  if (!sprint) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Sprint not found');
  }
  const isAdmin = req.user.platformSuperUser || (await userIsAdmin(req.user));
  const isOwner = String(sprint.createdBy?._id || sprint.createdBy) === String(req.user.id || req.user._id);
  const apiPerms = req.authContext?.permissions;
  const hasReadPerm = !!apiPerms && (apiPerms.has('tasks.read') || apiPerms.has('tasks.manage'));
  if (!isAdmin && !isOwner && !hasReadPerm) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  res.send(sprint);
});

const update = catchAsync(async (req, res) => {
  const sprint = await updateSprintById(req.params.sprintId, req.body, req.user);
  res.send(sprint);
});

const remove = catchAsync(async (req, res) => {
  await deleteSprintById(req.params.sprintId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, list, get, update, remove };
