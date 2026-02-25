import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createTeamMember,
  queryTeamMembers,
  getTeamMemberById,
  updateTeamMemberById,
  deleteTeamMemberById,
} from '../services/team.service.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const member = await createTeamMember(createdById, req.body);
  res.status(httpStatus.CREATED).send(member);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['teamGroup', 'teamId', 'search']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryTeamMembers(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const member = await getTeamMemberById(req.params.teamMemberId);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  res.send(member);
});

const update = catchAsync(async (req, res) => {
  const member = await updateTeamMemberById(req.params.teamMemberId, req.body, req.user);
  res.send(member);
});

const remove = catchAsync(async (req, res) => {
  await deleteTeamMemberById(req.params.teamMemberId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, list, get, update, remove };

