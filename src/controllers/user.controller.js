import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as userService from '../services/user.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.USER_CREATE,
    EntityTypes.USER,
    user.id,
    { role: user.role },
    req
  );
  res.status(httpStatus.CREATED).send(user);
});

const getUsers = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'role', 'status', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.queryUsers(filter, options);
  res.send(result);
});

const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserById(req.params.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  res.send(user);
});

const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.params.userId, req.body);
  const metadata = {};
  if (req.body.status !== undefined) {
    metadata.field = 'status';
    metadata.newValue = req.body.status;
  }
  const action =
    req.body.status === 'disabled' || req.body.status === 'deleted'
      ? ActivityActions.USER_DISABLE
      : ActivityActions.USER_UPDATE;
  await activityLogService.createActivityLog(req.user.id, action, EntityTypes.USER, user.id, metadata, req);
  res.send(user);
});

const deleteUser = catchAsync(async (req, res) => {
  await userService.deleteUserById(req.params.userId);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.USER_DELETE,
    EntityTypes.USER,
    req.params.userId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

export { createUser, getUsers, getUser, updateUser, deleteUser };
