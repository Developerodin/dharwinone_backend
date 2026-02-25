import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createProject,
  queryProjects,
  getProjectById,
  updateProjectById,
  deleteProjectById,
} from '../services/project.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const project = await createProject(createdById, req.body);
  res.status(httpStatus.CREATED).send(project);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search', 'status', 'priority']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;

  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryProjects(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  }

  const isAdmin = await userIsAdmin(req.user);
  const isOwner = String(project.createdBy?._id || project.createdBy) === String(req.user.id || req.user._id);
  if (!isAdmin && !isOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  res.send(project);
});

const update = catchAsync(async (req, res) => {
  const project = await updateProjectById(req.params.projectId, req.body, req.user);
  res.send(project);
});

const remove = catchAsync(async (req, res) => {
  await deleteProjectById(req.params.projectId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, list, get, update, remove };
