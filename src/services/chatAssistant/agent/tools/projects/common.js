import mongoose from 'mongoose';
import ProjectModel from '../../../../../models/project.model.js';
import TaskModel from '../../../../../models/task.model.js';
import TeamMemberModel from '../../../../../models/team.model.js';
import UserModel from '../../../../../models/user.model.js';
import { queryProjects as realQueryProjects } from '../../../../project.service.js';
import { queryTeamGroups as realQueryTeamGroups } from '../../../../teamGroup.service.js';
import { queryTasks as realQueryTasks } from '../../../../task.service.js';
import { getTeamMembersByTeam as realGetTeamMembersByTeam } from '../../../../team.service.js';
import { userIsAdmin } from '../../../../../utils/roleHelpers.js';
import { hasApiPermissionFromContext } from '../../../../../utils/permissionCheck.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
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
import { dayRange, dayWindowBounds } from '../employees/common.js';
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
    Task: deps.Task ?? TaskModel,
    TeamMember: deps.TeamMember ?? TeamMemberModel,
    User: deps.User ?? UserModel,
    now: deps.now,
  };
}

const HEX_ID = /^[a-fA-F0-9]{24}$/;

function clock(deps) {
  const n = deps?.now;
  if (typeof n === 'function') return new Date(n());
  if (n instanceof Date) return new Date(n.getTime());
  return new Date();
}

/** Start of the IST day `days` ago. "No updates in 7 days" is updatedAt strictly before this instant. */
export function istDaysAgoStart(days, now = new Date()) {
  const today = dateStrInTz(now, DEFAULT_TIMEZONE);
  const boundaryDay = addDaysToDateStr(today, -Number(days));
  const { from } = dayWindowBounds({ from: boundaryDay });
  return new Date(from);
}

function iso(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clipPlain(value, max) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

/** Project descriptions are stored as HTML; the Projects list shows the stripped text. */
function clipHtml(value, max) {
  const s = String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

function personName(v) {
  if (!v || typeof v !== 'object') return null;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  return name || null;
}

function hexId(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId)) {
    if (v._id != null || v.id != null) return hexId(v._id ?? v.id);
  }
  const s = String(v);
  return HEX_ID.test(s) ? s : null;
}

/**
 * Comment route is GET /tasks/:taskId/comments → requirePermissions('tasks.read')
 * (tasks.read or kanban.read, or platform super). Administrator-by-name and
 * tasks.manage do not pass that route. The list payload still embeds comments;
 * those bodies are not returned unless this check passes.
 */
export function viewerCanReadTaskComments(user) {
  return hasApiPermissionFromContext(user?.authContext?.permissions, !!user?.platformSuperUser, 'tasks.read');
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
  let activityById = null;
  if (filters.inactiveDays) {
    const now = clock(deps);
    activityById = await allProjectActivity(deps);
    const cutoff = istDaysAgoStart(filters.inactiveDays, now);
    const activeIds = [];
    for (const [id, at] of activityById) {
      if (at && new Date(at) >= cutoff) activeIds.push(new mongoose.Types.ObjectId(id));
    }
    if (activeIds.length) filter._id = { $nin: activeIds };
  }
  return { filter, scope: orgWide ? 'all' : 'mine', activityById };
}

export function projectRow(p, lastActivityAt = null) {
  return {
    id: idOf(p),
    name: p.name ?? null,
    status: p.status ?? null,
    priority: p.priority ?? null,
    projectManager: typeof p.projectManager === 'string' ? p.projectManager : null,
    startDate: p.startDate ?? null,
    endDate: p.endDate ?? null,
    teams: (p.assignedTeams || []).map(nameOf).filter(Boolean),
    createdBy: personName(p.createdBy),
    description: clipHtml(p.description, 300),
    members: (p.assignedTo || []).map(personName).filter(Boolean),
    lastActivityAt: lastActivityAt ?? null,
  };
}

/**
 * Latest task updatedAt per project. One aggregation.
 * ponytail: inactiveDays groups every task that has a projectId. Ceiling: the task
 * collection. Upgrade: index { updatedAt: 1, projectId: 1 }, $match the recent
 * window, then a second aggregation for the page's lastActivityAt.
 */
async function aggregateActivity(deps, match) {
  const rows = await deps.Task.aggregate([
    { $match: match },
    { $group: { _id: '$projectId', lastActivityAt: { $max: '$updatedAt' } } },
  ]);
  return new Map((rows || []).map((r) => [String(r._id), iso(r.lastActivityAt)]));
}

async function allProjectActivity(deps) {
  return aggregateActivity(deps, { projectId: { $ne: null } });
}

export async function activityForProjects(ids, deps) {
  const oids = [...new Set((ids || []).map((id) => String(id)).filter((id) => HEX_ID.test(id)))]
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!oids.length) return new Map();
  return aggregateActivity(deps, { projectId: { $in: oids } });
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

  if (filters.createdBy) {
    let createdById = HEX_ID.test(String(filters.createdBy)) ? String(filters.createdBy) : null;
    if (!createdById) {
      const res = await deps.resolveAssignee(filters.createdBy);
      if (res.kind === 'ambiguous') return { result: { ambiguous: 'creator', total: 0, matches: res.matches } };
      if (res.kind !== 'found') return { result: { notFound: 'creator', searchedFor: filters.createdBy, total: 0 } };
      [createdById] = res.userIds;
    }
    // queryTasks applyCommaFilter('createdBy') expects an id string and casts it.
    // Without tasks.read the service also forces assignedToMe, so other people's tasks stay hidden.
    if (createdById) filter.createdBy = createdById;
  }

  const updated = {};
  if (filters.updatedSince) {
    const { from } = dayWindowBounds({ from: filters.updatedSince });
    updated.$gte = new Date(from);
  }
  if (filters.noUpdateDays) {
    updated.$lt = istDaysAgoStart(filters.noUpdateDays, clock(deps));
  }
  if (updated.$gte || updated.$lt) filter.updatedAt = updated;

  if (filters.hasComments === true) filter.commentsCount = { $gt: 0 };
  if (filters.hasComments === false) filter.commentsCount = { $not: { $gt: 0 } };

  return { filter, scope: assignedToMe ? 'mine' : 'all' };
}

/** One queryTasks count on a fresh copy — queryTasks mutates the filter it is given. */
export async function countWith(deps, filter, extra = {}) {
  const res = await deps.queryTasks({ ...filter, ...extra }, { limit: 1 });
  return res?.totalResults ?? 0;
}

function resolveCommentBy(commentedBy, authors) {
  if (commentedBy && typeof commentedBy === 'object') {
    const name = personName(commentedBy);
    if (name) return name;
    const loaded = authors.get(hexId(commentedBy));
    const loadedName = personName(loaded);
    if (loadedName) return loadedName;
    // The comment UI shows email only when the author has no name.
    const email = typeof commentedBy.email === 'string' ? commentedBy.email.trim() : '';
    if (email) return email;
    const loadedEmail = typeof loaded?.email === 'string' ? loaded.email.trim() : '';
    return loadedEmail || null;
  }
  const loaded = authors.get(hexId(commentedBy));
  if (!loaded) return null;
  return personName(loaded) || (typeof loaded.email === 'string' ? loaded.email.trim() : '') || null;
}

function lastCommentOf(task, authors) {
  const comments = Array.isArray(task.comments) ? task.comments : [];
  if (!comments.length) return null;
  let best = comments[0];
  let bestAt = Date.parse(best?.createdAt ?? '') || 0;
  for (const c of comments.slice(1)) {
    const at = Date.parse(c?.createdAt ?? '') || 0;
    if (at >= bestAt) { best = c; bestAt = at; }
  }
  return {
    by: resolveCommentBy(best.commentedBy, authors),
    at: iso(best.createdAt),
    text: clipPlain(best.content, 200),
  };
}

async function commentAuthorMap(tasks, deps) {
  const need = new Set();
  for (const t of tasks || []) {
    for (const c of t.comments || []) {
      const by = c?.commentedBy;
      if (by && typeof by === 'object' && personName(by)) continue;
      if (by && typeof by === 'object' && typeof by.email === 'string' && by.email.trim()) continue;
      const id = hexId(by);
      if (id) need.add(id);
    }
  }
  const authors = new Map();
  if (!need.size || typeof deps.User?.find !== 'function') return authors;
  const ids = [...need].map((id) => new mongoose.Types.ObjectId(id));
  const users = await deps.User.find({ _id: { $in: ids } }).select('name email').lean();
  for (const u of users || []) {
    const id = hexId(u);
    if (id) authors.set(id, u);
  }
  return authors;
}

export function taskRow(t, { commentsVisible = false, authors = new Map() } = {}) {
  const createdBy = personName(t.createdBy) || personName(authors.get(hexId(t.createdBy)));
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
    createdBy,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    commentsCount: Number.isFinite(t.commentsCount) ? t.commentsCount : 0,
    // Comment text, author names and emails stay off the row unless the comment API would return them.
    lastComment: commentsVisible ? lastCommentOf(t, authors) : null,
    attachmentsCount: Number.isFinite(t.attachmentsCount) ? t.attachmentsCount : 0,
  };
}

/** Creator display names for rows queryTasks left as ids. Name only — never email. */
async function creatorNameMap(tasks, deps, authors) {
  const need = [];
  for (const t of tasks || []) {
    if (personName(t.createdBy)) continue;
    const id = hexId(t.createdBy);
    if (id && !personName(authors.get(id))) need.push(id);
  }
  if (!need.length || typeof deps.User?.find !== 'function') return;
  const ids = [...new Set(need)].map((id) => new mongoose.Types.ObjectId(id));
  const users = await deps.User.find({ _id: { $in: ids } }).select('name').lean();
  for (const u of users || []) {
    const id = hexId(u);
    if (id) authors.set(id, { name: u.name });
  }
}

export async function mapTaskRows(tasks, user, deps) {
  const list = tasks || [];
  const commentsVisible = viewerCanReadTaskComments(user);
  const authors = commentsVisible ? await commentAuthorMap(list, deps) : new Map();
  await creatorNameMap(list, deps, authors);
  return {
    commentsVisible,
    records: list.map((t) => taskRow(t, { commentsVisible, authors })),
  };
}

export { buildProjectQueryContext, summarizeTeamMembers };

export function countFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}
