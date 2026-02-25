import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createTeamGroup,
  queryTeamGroups,
  getTeamGroupById,
  updateTeamGroupById,
  deleteTeamGroupById,
} from '../services/teamGroup.service.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const team = await createTeamGroup(createdById, req.body);
  res.status(httpStatus.CREATED).send(team);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryTeamGroups(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const team = await getTeamGroupById(req.params.teamGroupId);
  if (!team) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team not found');
  }
  res.send(team);
});

const update = catchAsync(async (req, res) => {
  const team = await updateTeamGroupById(req.params.teamGroupId, req.body, req.user);
  res.send(team);
});

const remove = catchAsync(async (req, res) => {
  await deleteTeamGroupById(req.params.teamGroupId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, list, get, update, remove };
