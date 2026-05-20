import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createTeamMemberRow,
  queryTeamMembers,
  getTeamMemberById,
  updateTeamMemberById,
  deleteTeamMemberById,
  linkOrphanToEmployee,
  softRemoveTeamMember,
  moveTeamMemberToTeam,
  enrichTeamMembersWithCandidateProfilePictureUrls,
} from '../services/team.service.js';
import TeamMember from '../models/team.model.js';
import { retryOrphanMatch as runRetryOrphanMatch } from '../jobs/workforceReconciliation.js';

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const member = await createTeamMemberRow(createdById, req.body);
  const canViewCandidateMedia = req.authContext?.permissions?.has('candidates.read');
  const [out] = await enrichTeamMembersWithCandidateProfilePictureUrls([member], { includeCandidateMedia: canViewCandidateMedia });
  res.status(httpStatus.CREATED).send(out);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['teamId', 'search', 'includeInactive']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.userEmail = req.user.email;
  filter.canViewCandidateMedia = req.authContext?.permissions?.has('candidates.read');
  filter.apiPermissions = req.authContext?.permissions;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryTeamMembers(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const member = await getTeamMemberById(req.params.teamMemberId);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  const canViewCandidateMedia = req.authContext?.permissions?.has('candidates.read');
  const [out] = await enrichTeamMembersWithCandidateProfilePictureUrls([member], { includeCandidateMedia: canViewCandidateMedia });
  res.send(out);
});

const update = catchAsync(async (req, res) => {
  const member = await updateTeamMemberById(req.params.teamMemberId, req.body, req.user);
  const canViewCandidateMedia = req.authContext?.permissions?.has('candidates.read');
  const [out] = await enrichTeamMembersWithCandidateProfilePictureUrls([member], { includeCandidateMedia: canViewCandidateMedia });
  res.send(out);
});

const remove = catchAsync(async (req, res) => {
  await deleteTeamMemberById(req.params.teamMemberId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export const linkOrphan = catchAsync(async (req, res) => {
  const tm = await linkOrphanToEmployee(req.params.teamMemberId, req.body.employeeId);
  res.send(tm);
});

export const softRemove = catchAsync(async (req, res) => {
  await softRemoveTeamMember(req.params.teamMemberId, { reason: req.body.removedReason });
  res.status(httpStatus.NO_CONTENT).send();
});

export const moveToTeam = catchAsync(async (req, res) => {
  const member = await moveTeamMemberToTeam(req.params.teamMemberId, req.body.teamId, req.user);
  const canViewCandidateMedia = req.authContext?.permissions?.has('candidates.read');
  const [out] = await enrichTeamMembersWithCandidateProfilePictureUrls([member], {
    includeCandidateMedia: canViewCandidateMedia,
  });
  res.send(out);
});

export const retryOrphanMatch = catchAsync(async (req, res) => {
  const { linked } = await runRetryOrphanMatch();
  const stillOrphan = await TeamMember.countDocuments({ employeeId: null, isActive: true });
  res.send({ matched: linked, stillOrphan });
});

export { create, list, get, update, remove };

