import mongoose from 'mongoose';
import Project from '../../models/project.model.js';
import Sprint from '../../models/sprint.model.js';
import { deriveDisplayFields } from '../../models/team.model.js';
import { queryProjects } from '../project.service.js';
import { queryTeamGroups } from '../teamGroup.service.js';
import { getTeamMembersByTeam } from '../team.service.js';
import { userIsAdmin } from '../../utils/roleHelpers.js';
import { hasApiPermissionFromContext } from '../../utils/permissionCheck.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildProjectQueryContext(user) {
  const perms = user?.authContext?.permissions;
  return {
    userRoleIds: user?.roleIds || [],
    userId: user?.id || user?._id,
    userEmail: user?.email || '',
    apiPermissions: perms instanceof Set ? perms : new Set(),
  };
}

/** Filter object for project.service.queryProjects — never pass chat-only fields like userEmail. */
export function buildProjectServiceFilter(user, options = {}) {
  const ctx = buildProjectQueryContext(user);
  const filter = {
    userRoleIds: ctx.userRoleIds,
    userId: ctx.userId,
    apiPermissions: ctx.apiPermissions,
  };
  if (options.status) filter.status = options.status;
  if (options.search) filter.search = options.search;
  if (options.mine) filter.mine = options.mine;
  return filter;
}

export async function hasProjectReadAccess(user) {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  const perms = user?.authContext?.permissions;
  return (
    hasApiPermissionFromContext(perms, false, 'projects.read')
    || hasApiPermissionFromContext(perms, false, 'projects.manage')
  );
}

export async function hasTeamReadAccess(user) {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  const perms = user?.authContext?.permissions;
  return (
    hasApiPermissionFromContext(perms, false, 'teams.read')
    || hasApiPermissionFromContext(perms, false, 'teams.manage')
  );
}

/** @returns {Promise<{ projects: object[], total: number, scope: 'all'|'mine' }>} */
export async function fetchAccessibleProjects(user, options = {}) {
  const ctx = buildProjectQueryContext(user);
  const isAdmin = await userIsAdmin({ roleIds: ctx.userRoleIds });
  const canSeeAll =
    isAdmin
    || ctx.apiPermissions.has('projects.read')
    || ctx.apiPermissions.has('projects.manage');

  const filter = buildProjectServiceFilter(user, options);

  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 200);
  const result = await queryProjects(filter, { limit, sortBy: '-createdAt' });
  const projects = result.results || [];
  return {
    projects,
    total: result.totalResults ?? projects.length,
    scope: canSeeAll ? 'all' : 'mine',
  };
}

/**
 * Resolve a project by ObjectId or fuzzy name within the caller's RBAC scope.
 * @returns {Promise<{ kind: 'found'|'notFound'|'ambiguous', project?: object, matches?: object[] }>}
 */
export async function resolveProjectByNameOrId(text, user) {
  const query = String(text || '').trim();
  if (!query) return { kind: 'notFound' };

  const { projects } = await fetchAccessibleProjects(user, { limit: 200 });

  if (mongoose.Types.ObjectId.isValid(query)) {
    const hit = projects.find((p) => String(p._id || p.id) === query);
    if (hit) return { kind: 'found', project: hit };
  }

  const re = new RegExp(escapeRegex(query), 'i');
  const matches = projects.filter((p) => re.test(p.name || ''));
  if (matches.length === 1) return { kind: 'found', project: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'notFound' };
}

/**
 * Resolve a workforce team (TeamGroup) by name, with roster rows.
 * @returns {Promise<{ kind: 'found'|'notFound'|'ambiguous', team?: object, members?: object[], matches?: object[] }>}
 */
export async function resolveTeamByName(text, user) {
  const query = String(text || '').trim();
  if (!query) return { kind: 'notFound' };

  const ctx = buildProjectQueryContext(user);
  const result = await queryTeamGroups(
    { ...ctx, search: query },
    { limit: 20, sortBy: '-createdAt' },
  );
  const teams = result.results || [];
  if (!teams.length) return { kind: 'notFound' };

  const exact = teams.filter((t) => new RegExp(`^${escapeRegex(query)}$`, 'i').test(t.name || ''));
  const pool = exact.length ? exact : teams;
  if (pool.length === 1) {
    const team = pool[0];
    const members = await getTeamMembersByTeam(team._id || team.id);
    return { kind: 'found', team, members };
  }
  return { kind: 'ambiguous', matches: pool };
}

/** @returns {Promise<string[]>} */
export async function projectIdsForTeam(teamId) {
  if (!teamId || !mongoose.Types.ObjectId.isValid(String(teamId))) return [];
  const ids = await Project.find({ assignedTeams: teamId }).distinct('_id').exec();
  return ids.map(String);
}

/** Summarize roster for a resolved team. */
export function summarizeTeamMembers(members = []) {
  return members.map((m) => {
    const d = deriveDisplayFields(m);
    return {
      name: d.displayName || 'Unknown',
      email: d.displayEmail || '',
      isOrphan: d.isOrphan,
    };
  });
}

/**
 * Resolve sprint by name within optional project scope.
 * @returns {Promise<{ kind: 'found'|'notFound'|'ambiguous', sprint?: object, matches?: object[] }>}
 */
export async function resolveSprintByNameOrId(text, projectId, user) {
  const query = String(text || '').trim();
  if (!query) return { kind: 'notFound' };

  if (mongoose.Types.ObjectId.isValid(query)) {
    const sprint = await Sprint.findById(query).lean();
    if (sprint) return { kind: 'found', sprint };
  }

  const filter = {};
  if (projectId && mongoose.Types.ObjectId.isValid(String(projectId))) {
    filter.projectId = projectId;
  } else if (user) {
    const { projects } = await fetchAccessibleProjects(user, { limit: 200 });
    const pids = projects.map((p) => p._id || p.id).filter(Boolean);
    if (!pids.length) return { kind: 'notFound' };
    filter.projectId = { $in: pids };
  }

  const re = new RegExp(escapeRegex(query), 'i');
  const sprints = await Sprint.find({ ...filter, name: re })
    .select('name status projectId startDate endDate')
    .limit(20)
    .lean();
  if (!sprints.length) return { kind: 'notFound' };

  const exact = sprints.filter((s) => new RegExp(`^${escapeRegex(query)}$`, 'i').test(s.name || ''));
  const pool = exact.length ? exact : sprints;
  if (pool.length === 1) return { kind: 'found', sprint: pool[0] };
  return { kind: 'ambiguous', matches: pool };
}
