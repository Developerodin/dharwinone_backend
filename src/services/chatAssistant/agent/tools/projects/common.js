import mongoose from 'mongoose';
import ProjectModel from '../../../../../models/project.model.js';
import TeamMemberModel from '../../../../../models/team.model.js';
import { queryProjects as realQueryProjects } from '../../../../project.service.js';
import { queryTeamGroups as realQueryTeamGroups } from '../../../../teamGroup.service.js';
import { queryTasks as realQueryTasks } from '../../../../task.service.js';
import { getTeamMembersByTeam as realGetTeamMembersByTeam } from '../../../../team.service.js';
import { userIsAdmin } from '../../../../../utils/roleHelpers.js';
import { checkAccessRule } from '../../../toolAccess.js';
import {
  buildProjectServiceFilter,
  buildProjectQueryContext,
  resolveProjectByNameOrId as realResolveProject,
  resolveTeamByName as realResolveTeam,
  resolveSprintByNameOrId as realResolveSprint,
  projectIdsForTeam as realProjectIdsForTeam,
  summarizeTeamMembers,
} from '../../../projectGraph.resolvers.js';
import { buildTaskServiceFilter, resolveAssigneeByName as realResolveAssignee } from '../../../taskAccess.js';
import { fetchWorkloadAnalytics as realFetchWorkload } from '../../../workloadAnalytics.js';
import { dayRange } from '../employees/common.js';
import { ACTIVE_PROJECT_STATUSES as CAPACITY_ACTIVE_STATUSES } from '../../../../projectCapacity.js';

// project.route.js GET / — projects.read, or my-projects.read for ?mine=1 (forced below).
export const PROJECTS_ACCESS = Object.freeze({ anyOf: ['projects.read', 'projects.manage', 'my-projects.read'] });
// teamGroup.route.js GET /
export const TEAMS_ACCESS = Object.freeze({ anyOf: ['teams.read', 'teams.manage'] });
// task.route.js requireTaskListAccess: tasks.read / Administrator for the org list; assignedToMe is open to
// every signed-in user, so the tools force assignedToMe for everyone else (see taskViewerScope).
export const TASKS_ACCESS = Object.freeze({ note: 'task.route requireTaskListAccess — own tasks for everyone, all with tasks.read' });
// fetchWorkloadAnalytics gates on projects.read/manage (and teams.read for team metrics) itself.
export const WORKLOAD_ACCESS = Object.freeze({ anyOf: ['projects.read', 'projects.manage'] });

export const MAX_LIST_LIMIT = 50;
export const ACTIVE_PROJECT_STATUSES = [...CAPACITY_ACTIVE_STATUSES];

export function workScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('project/task tools need an authenticated user with an id');
  }
  return ctx.user;
}

export function workDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    queryProjects: deps.queryProjects ?? realQueryProjects,
    queryTeamGroups: deps.queryTeamGroups ?? realQueryTeamGroups,
    queryTasks: deps.queryTasks ?? realQueryTasks,
    getTeamMembersByTeam: deps.getTeamMembersByTeam ?? realGetTeamMembersByTeam,
    resolveProject: deps.resolveProject ?? realResolveProject,
    resolveTeam: deps.resolveTeam ?? realResolveTeam,
    resolveSprint: deps.resolveSprint ?? realResolveSprint,
    projectIdsForTeam: deps.projectIdsForTeam ?? realProjectIdsForTeam,
    resolveAssignee: deps.resolveAssignee ?? realResolveAssignee,
    fetchWorkloadAnalytics: deps.fetchWorkloadAnalytics ?? realFetchWorkload,
    isAdmin: deps.isAdmin ?? userIsAdmin,
    Project: deps.Project ?? ProjectModel,
    TeamMember: deps.TeamMember ?? TeamMemberModel,
  };
}

export const idOf = (v) => (v == null ? null : String(v?._id ?? v?.id ?? v));
const nameOf = (v) => (v && typeof v === 'object' ? v.name ?? null : null);

// ---------- projects ----------

/**
 * Viewers without projects.read/manage only get the My Projects list (?mine=1), like the page. Exact keys,
 * not getGrantingPermissions — that expands projects.read to my-projects.read / kanban.* too, while
 * queryProjects' own canSeeAll checks the exact keys.
 */
export async function projectFilterFor(user, filters = {}, deps) {
  const perms = user?.authContext?.permissions;
  const orgWide = !!user?.platformSuperUser
    || !!(perms?.has?.('projects.read') || perms?.has?.('projects.manage'))
    || await deps.isAdmin(user);
  const filter = buildProjectServiceFilter(user, {
    search: filters.search,
    status: filters.status,
    mine: orgWide ? undefined : true,
  });
  if (filters.priority) filter.priority = filters.priority;
  if (filters.teamAssignment === 'assigned') filter['assignedTeams.0'] = { $exists: true };
  if (filters.teamAssignment === 'unassigned') filter['assignedTeams.0'] = { $exists: false };
  return { filter, scope: orgWide ? 'all' : 'mine' };
}

export function projectRow(p) {
  return {
    id: idOf(p),
    name: p.name ?? null,
    status: p.status ?? null,
    priority: p.priority ?? null,
    projectManager: typeof p.projectManager === 'string' ? p.projectManager : null,
    startDate: p.startDate ?? null,
    endDate: p.endDate ?? null,
    teams: (p.assignedTeams || []).map(nameOf).filter(Boolean),
  };
}

// ---------- tasks ----------

/**
 * Mirrors task.route.js: tasks.read/manage or Administrator sees the org-wide board (queryTasks then
 * applies its own kanban-view-only scope); everyone else gets assignedToMe, the dashboard "My Tasks".
 */
export async function taskViewerScope(user, deps) {
  if (user?.platformSuperUser) return { orgWide: true };
  const rule = await checkAccessRule(
    { anyOf: ['tasks.read', 'tasks.manage'], adminByName: true }, user, { isAdmin: deps.isAdmin },
  );
  return { orgWide: rule.ok };
}

/**
 * Tool filters → a queryTasks filter. Returns { filter, scope }, or { result } when a name did not
 * resolve (notFound / ambiguous) or the viewer asked for someone else's tasks without tasks.read.
 */
export async function buildTaskFilter(user, filters = {}, deps) {
  const { orgWide } = await taskViewerScope(user, deps);
  const selfId = String(user.id ?? user._id);
  const assignedToMe = !!filters.assignedToMe || !orgWide;
  const opts = {
    status: filters.status,
    search: filters.search,
    assignedToMe: assignedToMe || undefined,
    unassigned: filters.unassigned,
    overdue: filters.overdue,
    blocked: filters.blocked,
    noDueDate: filters.noDueDate,
  };

  let projectId = filters.projectId;
  if (!projectId && filters.projectName) {
    const res = await deps.resolveProject(filters.projectName, user);
    if (res.kind === 'ambiguous') {
      return { result: { ambiguous: 'project', total: 0, matches: res.matches.map((p) => ({ id: idOf(p), name: p.name })) } };
    }
    if (res.kind !== 'found') return { result: { notFound: 'project', searchedFor: filters.projectName, total: 0 } };
    projectId = idOf(res.project);
  }
  if (filters.teamName) {
    const res = await deps.resolveTeam(filters.teamName, user);
    if (res.kind === 'ambiguous') {
      return { result: { ambiguous: 'team', total: 0, matches: res.matches.map((t) => ({ id: idOf(t), name: t.name })) } };
    }
    if (res.kind !== 'found') return { result: { notFound: 'team', searchedFor: filters.teamName, total: 0 } };
    const pids = await deps.projectIdsForTeam(idOf(res.team));
    if (projectId) {
      if (!pids.includes(String(projectId))) return { result: { total: 0, records: [] } };
    } else {
      if (!pids.length) return { result: { total: 0, records: [], note: 'That team has no projects.' } };
      projectId = { $in: pids.map((id) => new mongoose.Types.ObjectId(id)) };
    }
  }
  if (filters.sprintName) {
    const res = await deps.resolveSprint(filters.sprintName, typeof projectId === 'string' ? projectId : null, user);
    if (res.kind !== 'found') return { result: { notFound: 'sprint', searchedFor: filters.sprintName, total: 0 } };
    opts.sprintId = idOf(res.sprint);
  }

  // Assignee: a real assignedTo clause (legacy B5 read the wrong arg key and returned every task).
  let assignedTo = null;
  if (filters.assigneeUserId) {
    assignedTo = String(filters.assigneeUserId);
  } else if (filters.assigneeName) {
    const res = await deps.resolveAssignee(filters.assigneeName);
    if (res.kind === 'ambiguous') return { result: { ambiguous: 'assignee', total: 0, matches: res.matches } };
    if (res.kind !== 'found') return { result: { notFound: 'assignee', searchedFor: filters.assigneeName, total: 0 } };
    [assignedTo] = res.userIds;
  }
  if (assignedTo && assignedToMe && assignedTo !== selfId) {
    // queryTasks would silently swap the assignee for the viewer; say so instead.
    return { result: { error: 'You can only see your own tasks — other people\'s tasks need tasks.read.' } };
  }

  const filter = buildTaskServiceFilter(user, opts);
  if (filters.priority) filter.priority = filters.priority;
  if (projectId) filter.projectId = projectId;
  if (assignedTo && !assignedToMe) {
    filter.assignedTo = mongoose.Types.ObjectId.isValid(assignedTo) ? new mongoose.Types.ObjectId(assignedTo) : assignedTo;
  }
  if (filters.dueBetween) {
    const { dueFrom, dueTo } = dayRange('due', filters.dueBetween);
    filter.dueDate = { ...(dueFrom ? { $gte: new Date(dueFrom) } : {}), ...(dueTo ? { $lte: new Date(dueTo) } : {}) };
    // queryTasks' overdue / noDueDate flags would overwrite this dueDate clause.
    delete filter.noDueDate;
    if (filter.overdue) {
      delete filter.overdue;
      if (!filter.status) filter.status = { $ne: 'completed' };
    }
  }
  return { filter, scope: assignedToMe ? 'mine' : 'all' };
}

/** One queryTasks count on a fresh copy — queryTasks mutates the filter it is given. */
export async function countWith(deps, filter, extra = {}) {
  const res = await deps.queryTasks({ ...filter, ...extra }, { limit: 1 });
  return res?.totalResults ?? 0;
}

export function taskRow(t) {
  return {
    id: idOf(t),
    code: t.taskCode ?? null,
    title: t.title ?? null,
    status: t.status ?? null,
    priority: t.priority ?? null,
    dueDate: t.dueDate ?? null,
    project: nameOf(t.projectId),
    sprint: nameOf(t.sprintId),
    assignees: (t.assignedTo || []).map(nameOf).filter(Boolean),
    blocked: (t.tags || []).some((tag) => /^blocked$/i.test(String(tag || '').trim())),
  };
}

export { buildProjectQueryContext, summarizeTeamMembers };

export function countFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}
