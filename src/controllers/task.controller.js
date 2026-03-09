import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createTask,
  queryTasks,
  getTaskById,
  updateTaskById,
  updateTaskStatusById,
  deleteTaskById,
  getTaskComments,
  addTaskComment,
} from '../services/task.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const task = await createTask(createdById, req.body);
  res.status(httpStatus.CREATED).send(task);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'projectId', 'search', 'assignedToMe']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryTasks(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const task = await getTaskById(req.params.taskId);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const isAdmin = await userIsAdmin(req.user);
  const isOwner = String(task.createdBy?._id || task.createdBy) === String(req.user.id || req.user._id);
  const isAssigned = (task.assignedTo || []).some(
    (u) => String(u._id || u) === String(req.user.id || req.user._id)
  );
  if (!isAdmin && !isOwner && !isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  res.send(task);
});

const update = catchAsync(async (req, res) => {
  const task = await updateTaskById(req.params.taskId, req.body, req.user);
  res.send(task);
});

const updateStatus = catchAsync(async (req, res) => {
  const { status, order } = req.body;
  const task = await updateTaskStatusById(req.params.taskId, status, order, req.user);
  res.send(task);
});

const remove = catchAsync(async (req, res) => {
  await deleteTaskById(req.params.taskId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

const listComments = catchAsync(async (req, res) => {
  const comments = await getTaskComments(req.params.taskId, req.user);
  res.send(comments);
});

const createComment = catchAsync(async (req, res) => {
  const comment = await addTaskComment(req.params.taskId, req.body.content, req.user);
  res.status(httpStatus.CREATED).send(comment);
});

export { create, list, get, update, updateStatus, remove, listComments, createComment };
