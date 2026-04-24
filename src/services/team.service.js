import httpStatus from 'http-status';
import TeamMember from '../models/team.model.js';
import Employee from '../models/employee.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import logger from '../config/logger.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEAM_LIST_LIMIT_MAX = 200;

const normalizeMemberEmail = (email) => String(email ?? '').trim().toLowerCase();

/**
 * For each roster row, attach candidateProfilePictureUrl when a Candidate exists with the same email
 * and has a stored profile picture (presigned URL). Does not require candidates.read — only teams.read
 * roster visibility already applied in queryTeamMembers.
 * @param {import('mongoose').Document[]|Record<string, unknown>[]} members
 * @returns {Promise<Record<string, unknown>[]>}
 */
const enrichTeamMembersWithCandidateProfilePictureUrls = async (members, { includeCandidateMedia = false } = {}) => {
  if (!members?.length) {
    return (members || []).map((m) => (m.toJSON ? m.toJSON() : { ...m }));
  }
  if (!includeCandidateMedia) {
    return members.map((m) => (m.toJSON ? m.toJSON() : { ...m }));
  }
  const normalizedEmails = [
    ...new Set(members.map((m) => normalizeMemberEmail(m.email)).filter(Boolean)),
  ];
  if (normalizedEmails.length === 0) {
    return members.map((m) => (m.toJSON ? m.toJSON() : { ...m }));
  }

  const candidates = await Employee.find({ email: { $in: normalizedEmails } })
    .select('email profilePicture')
    .lean();

  /** @type {Map<string, string>} */
  const urlByEmail = new Map();
  await Promise.all(
    candidates.map(async (c) => {
      const key = normalizeMemberEmail(c.email);
      if (!key || !c.profilePicture?.key) return;
      try {
        const url = await generatePresignedDownloadUrl(c.profilePicture.key, 7 * 24 * 3600);
        urlByEmail.set(key, url);
      } catch (e) {
        logger.warn(`Team roster: presign profile picture failed for ${key}: ${e?.message}`);
      }
    })
  );

  return members.map((m) => {
    const obj = m.toJSON ? m.toJSON() : { ...m };
    const key = normalizeMemberEmail(m.email);
    const u = key ? urlByEmail.get(key) : undefined;
    if (u) obj.candidateProfilePictureUrl = u;
    return obj;
  });
};

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
    const searchRegex = new RegExp(escapeRegex(filter.search), 'i');
    filter.$or = [
      { name: searchRegex },
      { email: searchRegex },
      { position: searchRegex },
    ];
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const userEmail = filter.userEmail;
  const canViewCandidateMedia = Boolean(filter.canViewCandidateMedia);
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.userEmail;
  delete filter.canViewCandidateMedia;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  let finalFilter = { ...filter };
  /**
   * Non-admins must see rosters they did not create: admins add TeamMember rows with createdBy = admin.
   * Show rows the user created, their own roster row (email match), or anyone on a team that lists them.
   */
  if (!isAdmin && userId) {
    const uemail = String(userEmail || '').trim();
    let teamIdsImOn = [];
    if (uemail) {
      teamIdsImOn = await TeamMember.distinct('teamId', {
        teamId: { $ne: null },
        email: new RegExp(`^${escapeRegex(uemail)}$`, 'i'),
      }).exec();
    }
    const visibilityOr = [
      { createdBy: userId },
      ...(uemail ? [{ email: new RegExp(`^${escapeRegex(uemail)}$`, 'i') }] : []),
      ...(teamIdsImOn.length
        ? [{ teamId: { $in: teamIdsImOn.filter((id) => id != null) } }]
        : []),
    ];
    finalFilter = {
      $and: [finalFilter, { $or: visibilityOr }],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0
    ? Math.min(TEAM_LIST_LIMIT_MAX, parseInt(options.limit, 10))
    : 100;
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
  const enrichedResults = await enrichTeamMembersWithCandidateProfilePictureUrls(results, { includeCandidateMedia: canViewCandidateMedia });
  return { results: enrichedResults, page, limit, totalPages, totalResults };
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
  enrichTeamMembersWithCandidateProfilePictureUrls,
};

