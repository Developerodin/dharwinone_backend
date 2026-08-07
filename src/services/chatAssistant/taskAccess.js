import mongoose from 'mongoose';
import Task from '../../models/task.model.js';
import Project from '../../models/project.model.js';
import Employee from '../../models/employee.model.js';
import User from '../../models/user.model.js';
import { userIsAdmin } from '../../utils/roleHelpers.js';
import { isKanbanViewOnlyScope } from '../../utils/kanbanScope.js';
import { hasApiPermissionFromContext } from '../../utils/permissionCheck.js';
import { queryTasks } from '../task.service.js';
import { buildProjectQueryContext } from './projectGraph.resolvers.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const OPEN_TASK_STATUSES = ['new', 'todo', 'on_going', 'in_review'];
export const OVERLOAD_TASK_THRESHOLD = 10;

/** Start of today UTC — overdue = dueDate strictly before this. */
export function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function isBlockedTask(task) {
  const tags = task?.tags || [];
  return tags.some((t) => /^blocked$/i.test(String(t || '').trim()));
}

export function blockedTaskClause() {
  return { tags: { $regex: /^blocked$/i } };
}

export function overdueTaskClause(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return {
    dueDate: { $lt: start, $ne: null },
    status: { $ne: 'completed' },
  };
}

/**
 * Build Mongo filter fragment matching task.service.queryTasks RBAC scope.
 * @returns {Promise<{ filter: object, scope: 'all'|'mine', canSeeAll: boolean }>}
 */
/** Filter object for task.service.queryTasks — never pass chat-only fields like userEmail. */
export function buildTaskServiceFilter(user, options = {}) {
  const ctx = buildProjectQueryContext(user);
  const filter = {
    userRoleIds: ctx.userRoleIds,
    userId: ctx.userId,
    apiPermissions: ctx.apiPermissions,
  };
  if (options.status) filter.status = options.status;
  if (options.search) filter.search = options.search;
  if (options.projectId) filter.projectId = options.projectId;
  if (options.sprintId) filter.sprintId = options.sprintId;
  if (options.assignedToMe) filter.assignedToMe = options.assignedToMe;
  if (options.unassigned) filter.unassigned = options.unassigned;
  if (options.leaving) filter.leaving = options.leaving;
  if (options.reassigned) filter.reassigned = options.reassigned;
  return filter;
}

export async function hasTaskReadAccess(user) {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  const perms = user?.authContext?.permissions;
  return (
    hasApiPermissionFromContext(perms, false, 'tasks.read')
    || hasApiPermissionFromContext(perms, false, 'tasks.manage')
  );
}

/** @returns {Promise<{ tasks: object[], total: number, scope: 'all'|'mine', canSeeAll: boolean }>} */
export async function fetchAccessibleTasks(user, options = {}) {
  const ctx = buildProjectQueryContext(user);
  const isAdmin = await userIsAdmin({ roleIds: ctx.userRoleIds });
  const canSeeAll =
    isAdmin
    || ctx.apiPermissions.has('tasks.read')
    || ctx.apiPermissions.has('tasks.manage');

  const filter = buildTaskServiceFilter(user, options);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const result = await queryTasks(filter, { limit, sortBy: options.sortBy || '-createdAt' });
  const tasks = result.results || [];
  return {
    tasks,
    total: result.totalResults ?? tasks.length,
    scope: canSeeAll ? 'all' : 'mine',
    canSeeAll,
  };
}

/** Entity hints for conversation memory after a fetch_tasks turn. */
export function extractTaskMemoryHints(fetched = {}) {
  const out = {};
  const data = fetched.fetch_tasks;
  if (data?.forbidden) return out;
  if (data && typeof data.total === 'number') {
    out.lastTaskCount = data.total;
    out.lastTopic = 'tasks';
    out.lastScope = data.scope || null;
  }
  return out;
}

export async function buildAccessibleTaskFilter(user, extra = {}) {
  const ctx = buildProjectQueryContext(user);
  const userId = ctx.userId;
  const isAdmin = await userIsAdmin({ roleIds: ctx.userRoleIds || [] });
  const canSeeAll =
    isAdmin
    || ctx.apiPermissions.has('tasks.read')
    || ctx.apiPermissions.has('tasks.manage');
  const kanbanViewOnly = isKanbanViewOnlyScope(ctx.apiPermissions, isAdmin);

  let filter = { ...extra };

  if ((kanbanViewOnly) && userId) {
    filter.assignedTo = userId;
  } else if (!canSeeAll && userId) {
    filter = {
      $and: [
        filter,
        { $or: [{ createdBy: userId }, { assignedTo: userId }] },
      ],
    };
  }

  if (canSeeAll) {
    filter.projectId = filter.projectId || { $ne: null };
  } else if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    const userOid = new mongoose.Types.ObjectId(String(userId));
    const assignedOnly = kanbanViewOnly;
    const orphanMatch = assignedOnly
      ? { assignedTo: userOid, projectId: { $ne: null } }
      : {
          projectId: { $ne: null },
          $or: [{ createdBy: userOid }, { assignedTo: userOid }],
        };
    const orphanRows = await Task.aggregate([
      { $match: orphanMatch },
      {
        $lookup: {
          from: Project.collection.name,
          localField: 'projectId',
          foreignField: '_id',
          as: 'proj',
        },
      },
      { $match: { proj: { $size: 0 } } },
      { $project: { _id: 1 } },
    ]);
    const orphanIds = orphanRows.map((r) => r._id);
    if (orphanIds.length) {
      filter = { $and: [filter, { _id: { $nin: orphanIds } }] };
    }
  }

  return {
    filter,
    scope: canSeeAll ? 'all' : 'mine',
    canSeeAll,
    ctx,
  };
}

/**
 * Resolve employee display name → User owner id(s).
 * @returns {Promise<{ kind: 'found'|'notFound'|'ambiguous', userIds?: string[], matches?: object[] }>}
 */
export async function resolveAssigneeByName(name) {
  const query = String(name || '').trim();
  if (!query) return { kind: 'notFound' };

  const re = new RegExp(escapeRegex(query), 'i');
  const [employees, users] = await Promise.all([
    Employee.find({ fullName: re }).select('fullName employeeId owner').limit(10).lean(),
    User.find({ name: re }).select('name email').limit(10).lean(),
  ]);

  const matches = [];
  for (const e of employees) {
    if (e.owner) {
      matches.push({
        userId: String(e.owner),
        name: e.fullName,
        employeeId: e.employeeId || null,
      });
    }
  }
  for (const u of users) {
    const id = String(u._id);
    if (!matches.some((m) => m.userId === id)) {
      matches.push({ userId: id, name: u.name, employeeId: null });
    }
  }

  const exact = matches.filter((m) => new RegExp(`^${escapeRegex(query)}$`, 'i').test(m.name || ''));
  const pool = exact.length ? exact : matches;
  if (pool.length === 1) return { kind: 'found', userIds: [pool[0].userId], match: pool[0] };
  if (pool.length > 1) return { kind: 'ambiguous', matches: pool };
  return { kind: 'notFound' };
}

/** Flatten task assignee User ids. */
export function assigneeUserIds(task) {
  return (task?.assignedTo || [])
    .map((a) => String(a?._id || a?.id || a))
    .filter(Boolean);
}
