import httpStatus from 'http-status';
import TeamMember, { buildRoleSnapshot } from '../models/team.model.js';
import TeamGroup from '../models/teamGroup.model.js';
import Employee from '../models/employee.model.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { hasApiPermission } from '../utils/permissionCheck.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import logger from '../config/logger.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whitespace-tolerant regex source — collapses runs of whitespace in the input
 * and maps each literal space to `\s+` so "Mohammed Osman" matches names stored
 * with extra spaces / tabs / NBSP (e.g. "Mohammed  Osman").
 */
const whitespaceTolerantRegexSource = (value) =>
  escapeRegex(String(value ?? '').trim().replace(/\s+/g, ' ')).replace(/ /g, '\\s+');
const TEAM_LIST_LIMIT_MAX = 200;

/** Legacy TeamMember fields the new API must reject (writers must use FK / legacy* fields). */
export const DROPPED_TEAMMEMBER_FIELDS = [
  'name',
  'email',
  'teamGroup',
  'position',
  'memberSinceLabel',
  'projectsCount',
  'coverImageUrl',
  'avatarImageUrl',
  'onlineStatus',
  'lastSeenLabel',
];

/**
 * @param {object} payload
 * @returns {string[]} dropped fields present in the payload
 */
export const findDroppedFields = (payload) =>
  DROPPED_TEAMMEMBER_FIELDS.filter((f) => payload != null && Object.prototype.hasOwnProperty.call(payload, f));

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

/**
 * Authoritative manage gate: platform super, owner, Administrator, or any active
 * role granting teams.manage. Honours the route-level permission guard so
 * non-admin holders of project.teams:create,edit,delete can edit roster rows.
 */
const canManageTeam = async (user, resource) => {
  if (!resource || !user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  if (String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id)) return true;
  return hasApiPermission(user, 'teams.manage');
};

/**
 * Creates a TeamMember row in FK or orphan shape. Rejects legacy denormalized fields.
 */
export const createTeamMemberRow = async (createdById, payload) => {
  const dropped = findDroppedFields(payload);
  if (dropped.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `TEAMMEMBER_DROPPED_FIELD_SUBMITTED: ${dropped.join(', ')}`);
  }
  if (payload.employeeId && (payload.legacyName || payload.legacyEmail)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'employeeId and legacy* fields are mutually exclusive');
  }
  if (!payload.employeeId && !(payload.legacyName && payload.legacyEmail)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Either employeeId or legacyName+legacyEmail is required');
  }
  const teamExists = await TeamGroup.exists({ _id: payload.teamId });
  if (!teamExists) throw new ApiError(httpStatus.NOT_FOUND, `Team ${payload.teamId} not found`);

  const doc = { ...payload, createdBy: createdById };
  if (payload.employeeId) {
    const emp = await Employee.findById(payload.employeeId).select('designation department');
    if (!emp) throw new ApiError(httpStatus.NOT_FOUND, `Employee ${payload.employeeId} not found`);
    doc.roleSnapshot = buildRoleSnapshot(emp, payload.seniority);
  } else {
    doc.orphanReason = payload.orphanReason || 'manual_create';
    doc.orphanDetectedAt = new Date();
  }
  const member = await TeamMember.create(doc);
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
    { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position designation companyAssignedEmail' },
  ]);
  return member;
};

/**
 * Returns roster rows for a team with derived display fields (toJSON populates them).
 */
export const getTeamMembersByTeam = async (teamId, { includeInactive = false } = {}) => {
  const filter = { teamId };
  // $ne:false (not =true) so pre-A1-migration rows lacking the isActive field still count as active.
  if (!includeInactive) filter.isActive = { $ne: false };
  return TeamMember.find(filter)
    .populate('employeeId', 'fullName email companyAssignedEmail profilePicture position designation department')
    .sort({ createdAt: -1 })
    .exec();
};

/** Moves an active roster row to another Team. Linked rows cannot duplicate (team, employee). */
export const moveTeamMemberToTeam = async (teamMemberId, teamId, currentUser) => {
  const teamExists = await TeamGroup.exists({ _id: teamId });
  if (!teamExists) throw new ApiError(httpStatus.NOT_FOUND, `Team ${teamId} not found`);

  const member = await getTeamMemberById(teamMemberId);
  if (!member) throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  if (!member.isActive) throw new ApiError(httpStatus.CONFLICT, 'Cannot move an inactive team member');

  const canUpdate = await canManageTeam(currentUser, member);
  if (!canUpdate) throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');

  if (String(member.teamId) === String(teamId)) {
    await member.populate([
      { path: 'createdBy', select: 'name email' },
      { path: 'teamId', select: 'name' },
      { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
    ]);
    return member;
  }

  if (member.employeeId) {
    const alreadyOnTeam = await TeamMember.exists({
      teamId,
      employeeId: member.employeeId,
      isActive: { $ne: false },
      _id: { $ne: member._id },
    });
    if (alreadyOnTeam) {
      throw new ApiError(httpStatus.CONFLICT, 'Employee is already an active member of that team');
    }
  }

  member.teamId = teamId;
  await member.save();
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
    { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
  ]);
  return member;
};

/** Soft-removes a roster row. Idempotent guard: already-removed -> 409. */
export const softRemoveTeamMember = async (teamMemberId, { reason }) => {
  const tm = await TeamMember.findById(teamMemberId);
  if (!tm) throw new ApiError(httpStatus.NOT_FOUND, `TeamMember ${teamMemberId} not found`);
  if (!tm.isActive) throw new ApiError(httpStatus.CONFLICT, 'TeamMember already removed');
  tm.isActive = false;
  tm.removedAt = new Date();
  tm.removedReason = reason;
  await tm.save();
  return tm;
};

/** Links an orphan row to a real Employee and clears orphan/legacy metadata. */
export const linkOrphanToEmployee = async (teamMemberId, employeeId) => {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw new ApiError(httpStatus.NOT_FOUND, `Employee ${employeeId} not found`);
  const tm = await TeamMember.findById(teamMemberId);
  if (!tm) throw new ApiError(httpStatus.NOT_FOUND, `TeamMember ${teamMemberId} not found`);
  tm.employeeId = emp._id;
  tm.roleSnapshot = buildRoleSnapshot(emp, tm.seniority);
  tm.legacyName = null;
  tm.legacyEmail = null;
  tm.orphanReason = null;
  tm.orphanDetectedAt = null;
  await tm.save();
  return tm;
};

/** Returns Employees whose position is in the team's relatedPositions and who are not already on it. */
export const bulkAutoSuggestForTeam = async (teamId) => {
  const team = await TeamGroup.findById(teamId);
  if (!team) throw new ApiError(httpStatus.NOT_FOUND, `Team ${teamId} not found`);
  if (!team.relatedPositions || !team.relatedPositions.length) return [];
  const onTeam = await TeamMember.find({ teamId, isActive: { $ne: false }, employeeId: { $ne: null } }).distinct('employeeId');
  return Employee.find({ position: { $in: team.relatedPositions }, _id: { $nin: onTeam } }).exec();
};

const createTeamMember = async (createdById, payload) => {
  const member = await TeamMember.create({
    createdBy: createdById,
    ...payload,
  });
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
    { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
  ]);
  return member;
};

const queryTeamMembers = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(whitespaceTolerantRegexSource(filter.search), 'i');
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
  const apiPermissions = filter.apiPermissions instanceof Set ? filter.apiPermissions : new Set();
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.userEmail;
  delete filter.canViewCandidateMedia;
  delete filter.apiPermissions;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  /** Org-wide list when admin OR role grants teams.read / teams.manage. */
  const canSeeAll = isAdmin || apiPermissions.has('teams.read') || apiPermissions.has('teams.manage');
  const includeInactive = filter.includeInactive === true || filter.includeInactive === 'true';
  delete filter.includeInactive;

  let finalFilter = { ...filter };
  if (!includeInactive) {
    // $ne:false (not =true) so pre-A1-migration rows lacking the isActive field still show.
    finalFilter.isActive = { $ne: false };
  }
  /**
   * Non-admins must see rosters they did not create: admins add TeamMember rows with createdBy = admin.
   * Show rows the user created, their own roster row (email match), or anyone on a team that lists them.
   */
  if (!canSeeAll && userId) {
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
        { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
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
    { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
  ]);
  return member;
};

const updateTeamMemberById = async (id, updateBody, currentUser) => {
  const dropped = findDroppedFields(updateBody);
  if (dropped.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `TEAMMEMBER_DROPPED_FIELD_SUBMITTED: ${dropped.join(', ')}`);
  }
  const member = await getTeamMemberById(id);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  const canUpdate = await canManageTeam(currentUser, member);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  Object.assign(member, updateBody);
  await member.save();
  await member.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'teamId', select: 'name' },
    { path: 'employeeId', select: 'employeeId name email isActive profilePicture department position' },
  ]);
  return member;
};

const deleteTeamMemberById = async (id, currentUser) => {
  const member = await getTeamMemberById(id);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  const canDelete = await canManageTeam(currentUser, member);
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

