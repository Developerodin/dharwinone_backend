import mongoose from 'mongoose';
import Project from '../../models/project.model.js';
import Sprint from '../../models/sprint.model.js';
import Task from '../../models/task.model.js';
import TeamGroup from '../../models/teamGroup.model.js';
import TeamMember, { deriveDisplayFields } from '../../models/team.model.js';
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

/** @returns {Promise<{ teams: object[], total: number, scope: 'all'|'mine' }>} */
export async function fetchAccessibleTeams(user, options = {}) {
  const ctx = buildProjectQueryContext(user);
  const isAdmin = await userIsAdmin({ roleIds: ctx.userRoleIds });
  const canSeeAll =
    isAdmin
    || ctx.apiPermissions.has('teams.read')
    || ctx.apiPermissions.has('teams.manage');

  const filter = { ...ctx };
  if (options.search) filter.search = options.search;

  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 200);
  const result = await queryTeamGroups(filter, { limit, sortBy: '-createdAt' });
  const teams = result.results || [];
  return {
    teams,
    total: result.totalResults ?? teams.length,
    scope: canSeeAll ? 'all' : 'mine',
  };
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

async function loadTeamMeta(teamIds) {
  const unique = [...new Set(teamIds.map(String).filter(Boolean))];
  const validIds = unique.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!validIds.length) return new Map();

  const teams = await TeamGroup.find({ _id: { $in: validIds } })
    .select('name teamLead department')
    .populate({ path: 'teamLead', select: 'fullName employeeId' })
    .lean();

  const counts = await TeamMember.aggregate([
    { $match: { teamId: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) }, isActive: { $ne: false } } },
    { $group: { _id: '$teamId', count: { $sum: 1 } } },
  ]);
  const countByTeam = new Map(counts.map((c) => [String(c._id), c.count]));

  const meta = new Map();
  for (const t of teams) {
    const id = String(t._id);
    const lead = t.teamLead;
    meta.set(id, {
      id,
      name: t.name,
      department: t.department || null,
      leadName: (lead && typeof lead === 'object' ? lead.fullName : null) || null,
      leadEmployeeId: (lead && typeof lead === 'object' ? lead.employeeId : null) || null,
      memberCount: countByTeam.get(id) ?? 0,
    });
  }
  return meta;
}

/**
 * Attach team name, lead, and member count to each project's assignedTeams.
 * @param {object[]} projects
 * @param {object} _user - reserved for future RBAC on team visibility
 */
export async function enrichProjectsWithTeams(projects, _user) {
  const list = Array.isArray(projects) ? projects : [];
  const teamIds = [];
  for (const p of list) {
    for (const tid of p.assignedTeams || []) {
      teamIds.push(String(tid?._id || tid?.id || tid));
    }
  }
  const meta = await loadTeamMeta(teamIds);

  return list.map((p) => {
    const enrichedTeams = (p.assignedTeams || [])
      .map((tid) => {
        const id = String(tid?._id || tid?.id || tid);
        const m = meta.get(id);
        if (m) return m;
        if (tid && typeof tid === 'object' && tid.name) {
          return {
            id,
            name: tid.name,
            leadName: null,
            leadEmployeeId: null,
            memberCount: 0,
          };
        }
        return null;
      })
      .filter(Boolean);
    return { ...p, enrichedTeams };
  });
}

/**
 * Flat rows for chatbot table rendering.
 * @param {object[]} enrichedProjects
 */
export function buildProjectTeamTable(enrichedProjects) {
  return (enrichedProjects || []).map((p) => {
    const teams = p.enrichedTeams || [];
    return {
      projectId: String(p._id || p.id),
      projectName: p.name,
      status: p.status || null,
      priority: p.priority || null,
      projectManager: typeof p.projectManager === 'string' ? p.projectManager : null,
      teams: teams.map((t) => ({
        teamId: t.id,
        teamName: t.name,
        teamLead: t.leadName || '—',
        memberCount: t.memberCount ?? 0,
      })),
      assignedTeamLabel: teams.length
        ? teams.map((t) => t.name).join(', ')
        : null,
      hasTeams: teams.length > 0,
    };
  });
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

/** @returns {Promise<object[]>} sprints belonging to a project */
export async function sprintsForProject(projectId) {
  if (!projectId || !mongoose.Types.ObjectId.isValid(String(projectId))) return [];
  return Sprint.find({ projectId })
    .select('name status startDate endDate projectId')
    .sort({ startDate: -1, createdAt: -1 })
    .lean();
}

/** @returns {Promise<object[]>} tasks in a sprint (lean rows) */
export async function tasksForSprint(sprintId) {
  if (!sprintId || !mongoose.Types.ObjectId.isValid(String(sprintId))) return [];
  return Task.find({ sprintId })
    .select('title status dueDate assignedTo projectId sprintId tags')
    .populate({ path: 'assignedTo', select: 'name email' })
    .populate({ path: 'projectId', select: 'name' })
    .lean();
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
