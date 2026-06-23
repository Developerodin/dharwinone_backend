import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Task from '../models/task.model.js';
import Project from '../models/project.model.js';
import Sprint from '../models/sprint.model.js';
import User from '../models/user.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { isKanbanViewOnlyScope } from '../utils/kanbanScope.js';
import { hasApiPermission } from '../utils/permissionCheck.js';
import { reserveTaskSeqRange, formatTaskCode } from './pmTaskCode.js';
import Employee from '../models/employee.model.js';
import { resignBucket } from '../utils/resignBucket.js';

const TASK_LIST_LIMIT_MAX = 200;
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseCommaList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const applyCommaFilter = (filter, key, transform = (v) => v) => {
  if (filter[key] == null || filter[key] === '') return;
  const values = parseCommaList(filter[key]).map(transform);
  if (!values.length) {
    delete filter[key];
    return;
  }
  filter[key] = values.length === 1 ? values[0] : { $in: values };
};

/**
 * Tasks created via raw insertMany often omit priority; the schema default is
 * "medium" but is not applied. UI treats missing as medium — match that here.
 */
const expandPriorityFilterForDefaultMedium = (filter) => {
  const p = filter.priority;
  if (p == null) return;

  const includeMissing = () => {
    if (typeof p === 'string') {
      filter.priority = { $in: ['medium', null, ''] };
      return;
    }
    if (p && typeof p === 'object' && Array.isArray(p.$in)) {
      const next = [...p.$in];
      if (!next.includes(null)) next.push(null);
      if (!next.includes('')) next.push('');
      filter.priority = { $in: next };
    }
  };

  if (p === 'medium') {
    includeMissing();
    return;
  }
  if (p && typeof p === 'object' && Array.isArray(p.$in) && p.$in.includes('medium')) {
    includeMissing();
  }
};

const sanitizeTaskWritePayload = (payload = {}) => {
  const next = { ...payload };
  // Server-managed counters; never trust direct client writes.
  delete next.likesCount;
  delete next.commentsCount;
  delete next.attachmentsCount;
  delete next.taskSeq;
  delete next.taskCode;
  if (next.sprintId === '') next.sprintId = null;
  return next;
};

const assertSprintMatchesTaskProject = async (sprintId, projectId) => {
  if (!sprintId) return;
  const sprint = await Sprint.findById(sprintId).select('projectId').lean();
  if (!sprint) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Sprint not found');
  }
  if (projectId && String(sprint.projectId) !== String(projectId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Sprint must belong to the same project as the task');
  }
};

/**
 * Recompute and persist Project.totalTasks + Project.completedTasks from the
 * authoritative Task collection. Called after every Task create / update / status /
 * delete that may touch a project so tiles stay in sync without a nightly resync.
 * The Task model uses status === 'completed' for done. Pass null/undefined to skip.
 */
const recomputeProjectCounters = async (projectId) => {
  if (!projectId) return;
  const oid = mongoose.Types.ObjectId.isValid(String(projectId))
    ? new mongoose.Types.ObjectId(String(projectId))
    : null;
  if (!oid) return;
  const [total, completed] = await Promise.all([
    Task.countDocuments({ projectId: oid }),
    Task.countDocuments({ projectId: oid, status: 'completed' }),
  ]);
  await Project.updateOne({ _id: oid }, { $set: { totalTasks: total, completedTasks: completed } });
};

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

/**
 * Authoritative manage gate: platform super, owner, Administrator, or any active
 * role granting tasks.manage. Honours route-level permission guard so non-admin
 * holders of project.tasks:create,edit,delete can assign / edit / delete tasks.
 */
const canManageTask = async (user, resource) => {
  if (!resource || !user) return false;
  if (user.platformSuperUser) return true;
  if (await userIsAdmin(user)) return true;
  if (String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id)) return true;
  return hasApiPermission(user, 'tasks.manage');
};

const createTask = async (createdById, payload) => {
  const safePayload = sanitizeTaskWritePayload(payload);
  await assertSprintMatchesTaskProject(safePayload.sprintId, safePayload.projectId);
  let numbering = {};
  if (safePayload.projectId) {
    const seq = await reserveTaskSeqRange(safePayload.projectId, 1);
    const project = await Project.findById(safePayload.projectId).select('projectKey').lean();
    numbering = { taskSeq: seq, taskCode: formatTaskCode(project?.projectKey || 'PRJ', seq) };
  }
  const task = await Task.create({
    createdBy: createdById,
    ...safePayload,
    ...numbering,
  });
  // Keep Project.totalTasks/completedTasks in sync whenever a task is added under a project.
  await recomputeProjectCounters(task.projectId);
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
    { path: 'sprintId', select: 'name status' },
  ]);
  const assignedIds = [...new Set((task.assignedTo || []).map((u) => String(u._id || u)).filter(Boolean))];
  const creatorStr = String(createdById);
  if (assignedIds.length > 0) {
    const { notify, plainTextEmailBody } = await import('./notification.service.js');
    const linkPath = '/task/my-tasks';
    const taskMsg = `"${task.title || 'Task'}" has been assigned to you.`;
    for (const uid of assignedIds) {
      if (uid !== creatorStr) {
        notify(uid, {
          type: 'task',
          title: 'Task assigned to you',
          message: taskMsg,
          link: linkPath,
          email: {
            subject: `Task assigned: ${task.title || 'Task'}`,
            text: plainTextEmailBody(taskMsg, linkPath),
          },
        }).catch(() => {});
      }
    }
  }
  return task;
};

const OFFBOARDING_SEVERITY = { resigned: 2, soon: 1 };

/** Pure: lean employee docs -> Map ownerId -> { bucket, name, resignDate }. */
export const buildOffboardingMap = (employees, now) => {
  const byOwner = new Map();
  for (const e of employees) {
    const bucket = resignBucket(e.resignDate, now);
    if (bucket) byOwner.set(String(e.owner), { bucket, name: e.fullName, resignDate: e.resignDate });
  }
  return byOwner;
};

/** Pure: set offboardingFlag + offboardingAssignees on OPEN tasks. Mutates and returns. */
export const applyOffboardingFlags = (plainTasks, byOwner) => {
  for (const t of plainTasks) {
    if (t.status === 'completed') continue;
    const flagged = [];
    for (const u of t.assignedTo || []) {
      const uid = String(u?.id || u?._id || u || '');
      const hit = byOwner.get(uid);
      if (hit) flagged.push({ id: uid, name: hit.name, resignDate: hit.resignDate, bucket: hit.bucket });
    }
    t.offboardingAssignees = flagged;
    if (flagged.length) {
      t.offboardingFlag = flagged.reduce(
        (best, f) => (OFFBOARDING_SEVERITY[f.bucket] > OFFBOARDING_SEVERITY[best] ? f.bucket : best),
        flagged[0].bucket
      );
    }
  }
  return plainTasks;
};

/** Pure: owner User id strings for employees whose resignDate buckets to soon/resigned. */
export const selectLeavingOwners = (employees, now) =>
  employees.filter((e) => e.owner && resignBucket(e.resignDate, now) !== null).map((e) => String(e.owner));

/** DB wrapper: enrich populated Task docs with derived offboarding fields. */
const enrichWithOffboarding = async (results, now) => {
  const plain = results.map((d) => (d?.toJSON ? d.toJSON() : d));
  const ids = new Set();
  for (const t of plain) {
    if (t.status === 'completed') continue;
    for (const u of t.assignedTo || []) {
      const uid = String(u?.id || u?._id || u || '');
      if (uid) ids.add(uid);
    }
  }
  if (ids.size === 0) return plain;
  const employees = await Employee.find({
    owner: { $in: [...ids] },
    resignDate: { $ne: null },
  })
    .select('owner fullName resignDate')
    .lean();
  return applyOffboardingFlags(plain, buildOffboardingMap(employees, now));
};

const queryTasks = async (filter, options) => {
  applyCommaFilter(filter, 'priority');
  expandPriorityFilterForDefaultMedium(filter);
  applyCommaFilter(filter, 'sprintId', (id) => new mongoose.Types.ObjectId(id));
  applyCommaFilter(filter, 'createdBy', (id) => new mongoose.Types.ObjectId(id));

  if (filter.search) {
    const searchRegex = new RegExp(escapeRegex(filter.search), 'i');
    const or = [
      { title: searchRegex },
      { description: searchRegex },
      { taskCode: searchRegex },
      { tags: searchRegex },
    ];
    // Also match tasks assigned to an employee whose name/email matches.
    const matchedUsers = await User.find({
      $or: [{ name: searchRegex }, { email: searchRegex }],
    })
      .select('_id')
      .lean()
      .exec();
    if (matchedUsers.length) {
      or.push({ assignedTo: { $in: matchedUsers.map((u) => u._id) } });
    }
    filter.$or = or;
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const apiPermissions = filter.apiPermissions instanceof Set ? filter.apiPermissions : new Set();
  const assignedToMe = filter.assignedToMe === true || filter.assignedToMe === 'true';
  const leavingOnly = filter.leaving === true || filter.leaving === 'true';
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.apiPermissions;
  delete filter.assignedToMe;
  delete filter.leaving;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  /** Org-wide list when admin OR role grants tasks.read / tasks.manage. */
  const canSeeAll = isAdmin || apiPermissions.has('tasks.read') || apiPermissions.has('tasks.manage');
  const kanbanViewOnly = isKanbanViewOnlyScope(apiPermissions, isAdmin);
  let finalFilter = { ...filter };

  if ((kanbanViewOnly || assignedToMe) && userId) {
    // Kanban view-only and explicit "assigned to me" — assigned tasks only
    finalFilter.assignedTo = userId;
  } else if (!canSeeAll && userId) {
    // Show tasks created by or assigned to the current user
    finalFilter = {
      $and: [
        finalFilter,
        { $or: [{ createdBy: userId }, { assignedTo: userId }] },
      ],
    };
  }

  /** Tasks whose project was deleted but projectId still points nowhere — hide from all lists (incl. admin). */
  let orphanMatch = null;
  if (canSeeAll) {
    orphanMatch = { projectId: { $ne: null } };
  } else if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    const userOid = new mongoose.Types.ObjectId(String(userId));
    orphanMatch = assignedToMe || kanbanViewOnly
      ? { assignedTo: userOid, projectId: { $ne: null } }
      : {
          projectId: { $ne: null },
          $or: [{ createdBy: userOid }, { assignedTo: userOid }],
        };
  }
  if (orphanMatch) {
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
      finalFilter = { $and: [finalFilter, { _id: { $nin: orphanIds } }] };
    }
  }

  // "Leaving" filter: only OPEN tasks assigned to an employee who is resigning soon
  // or already resigned. Computed server-side so it works across pagination, like priority.
  if (leavingOnly) {
    const leavingEmps = await Employee.find({ resignDate: { $ne: null } })
      .select('owner resignDate')
      .lean();
    const leavingOwnerIds = selectLeavingOwners(leavingEmps, new Date()).map(
      (id) => new mongoose.Types.ObjectId(id)
    );
    finalFilter = {
      $and: [finalFilter, { assignedTo: { $in: leavingOwnerIds }, status: { $ne: 'completed' } }],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0
    ? Math.min(TASK_LIST_LIMIT_MAX, parseInt(options.limit, 10))
    : 100;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    Task.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'createdBy', select: 'name email' },
        { path: 'assignedTo', select: 'name email phoneNumber location profilePicture' },
        { path: 'projectId', select: 'name' },
        { path: 'sprintId', select: 'name status' },
      ])
      .exec(),
    Task.countDocuments(finalFilter).exec(),
  ]);

  const totalPages = Math.ceil(totalResults / limit);
  const enriched = await enrichWithOffboarding(results, new Date());
  return { results: enriched, page, limit, totalPages, totalResults };
};

const getTaskById = async (id) => {
  const task = await Task.findById(id).exec();
  if (!task) return null;
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'assignedTo', select: 'name email phoneNumber location profilePicture' },
    { path: 'projectId', select: 'name' },
    { path: 'sprintId', select: 'name status' },
    { path: 'comments.commentedBy', select: 'name email' },
  ]);
  return task;
};

const updateTaskById = async (id, updateBody, currentUser) => {
  const task = await getTaskById(id);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const canUpdate = await canManageTask(currentUser, task);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const prevAssigned = new Set((task.assignedTo || []).map((u) => String(u._id || u)));
  const prevProjectId = task.projectId?._id || task.projectId;
  const safePayload = sanitizeTaskWritePayload(updateBody);
  const nextProjectId = safePayload.projectId ?? prevProjectId;
  const nextSprintId =
    safePayload.sprintId !== undefined ? safePayload.sprintId : task.sprintId?._id || task.sprintId;
  await assertSprintMatchesTaskProject(nextSprintId, nextProjectId);
  Object.assign(task, safePayload);
  await task.save();
  // Resync counters: status or projectId may have changed. If the task moved between
  // projects, recompute both old and new so the previous tile drops the count.
  const newProjectId = task.projectId?._id || task.projectId;
  await recomputeProjectCounters(newProjectId);
  if (prevProjectId && String(prevProjectId) !== String(newProjectId)) {
    await recomputeProjectCounters(prevProjectId);
  }
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
    { path: 'sprintId', select: 'name status' },
  ]);
  const newAssigned = new Set((task.assignedTo || []).map((u) => String(u._id || u)));
  const currentStr = String(currentUser.id || currentUser._id);
  const newlyAssigned = [...newAssigned].filter((uid) => !prevAssigned.has(uid) && uid !== currentStr);
  if (newlyAssigned.length > 0) {
    const { notify, plainTextEmailBody } = await import('./notification.service.js');
    const linkPath = '/task/my-tasks';
    const taskMsg = `"${task.title || 'Task'}" has been assigned to you.`;
    for (const uid of newlyAssigned) {
      notify(uid, {
        type: 'task',
        title: 'Task assigned to you',
        message: taskMsg,
        link: linkPath,
        email: {
          subject: `Task assigned: ${task.title || 'Task'}`,
          text: plainTextEmailBody(taskMsg, linkPath),
        },
      }).catch(() => {});
    }
  }
  return task;
};

const updateTaskStatusById = async (id, status, order, currentUser) => {
  const task = await getTaskById(id);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const canUpdate = await canManageTask(currentUser, task);
  const isAssigned = (task.assignedTo || []).some(
    (u) => String(u._id || u) === String(currentUser.id || currentUser._id)
  );
  
  if (!canUpdate && !isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  
  const creatorId = task.createdBy?._id || task.createdBy;
  task.status = status;
  if (typeof order === 'number') task.order = order;
  await task.save();
  // Status moved to/from 'completed' affects Project.completedTasks. Recompute so the
  // task board's project tile reflects the kanban move immediately.
  await recomputeProjectCounters(task.projectId?._id || task.projectId);
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
    { path: 'sprintId', select: 'name status' },
  ]);
  const { notify, plainTextEmailBody } = await import('./notification.service.js');
  const currentStr = String(currentUser.id || currentUser._id);
  const statusMsg = `"${task.title || 'Task'}" is now ${status}.`;
  if (creatorId && String(creatorId) !== currentStr) {
    const boardPath = '/task/kanban-board';
    notify(creatorId, {
      type: 'task',
      title: 'Task status updated',
      message: statusMsg,
      link: boardPath,
      email: {
        subject: `Task update: ${task.title || 'Task'}`,
        text: plainTextEmailBody(statusMsg, boardPath),
      },
    }).catch(() => {});
  }
  const assignedIds = [...new Set((task.assignedTo || []).map((u) => String(u._id || u)).filter(Boolean))];
  const myTasksPath = '/task/my-tasks';
  for (const uid of assignedIds) {
    if (uid !== currentStr && uid !== String(creatorId)) {
      notify(uid, {
        type: 'task',
        title: 'Task status updated',
        message: statusMsg,
        link: myTasksPath,
        email: {
          subject: `Task update: ${task.title || 'Task'}`,
          text: plainTextEmailBody(statusMsg, myTasksPath),
        },
      }).catch(() => {});
    }
  }
  return task;
};

const deleteTaskById = async (id, currentUser) => {
  const task = await getTaskById(id);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const canDelete = await canManageTask(currentUser, task);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const projectIdForResync = task.projectId?._id || task.projectId;
  await task.deleteOne();
  // Resync after delete so the project tile decrements totalTasks (and completedTasks
  // when a completed task is removed).
  await recomputeProjectCounters(projectIdForResync);
  return task;
};

const canCommentOnTask = (task, userId) => {
  if (!task || !userId) return false;
  const uid = String(userId);
  const creatorId = String(task.createdBy?._id || task.createdBy);
  if (uid === creatorId) return true;
  const assignedIds = (task.assignedTo || []).map((u) => String(u._id || u));
  return assignedIds.includes(uid);
};

const getTaskComments = async (taskId, currentUser) => {
  const task = await Task.findById(taskId)
    .populate({
      path: 'comments.commentedBy',
      select: 'name email',
    })
    .lean();
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const admin = await userIsAdmin(currentUser);
  let allowed = admin || canCommentOnTask(task, currentUser.id || currentUser._id);
  if (!allowed) allowed = await hasApiPermission(currentUser, 'tasks.read');
  if (!allowed) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  return task.comments || [];
};

const addTaskComment = async (taskId, content, currentUser) => {
  const task = await Task.findById(taskId).exec();
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const userId = currentUser.id || currentUser._id;
  const admin = await userIsAdmin(currentUser);
  let allowed = admin || canCommentOnTask(task, userId);
  if (!allowed) allowed = await hasApiPermission(currentUser, 'tasks.read');
  if (!allowed) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const comment = {
    content: (content || '').trim(),
    commentedBy: userId,
  };
  if (!comment.content) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Comment content is required');
  }
  task.comments = task.comments || [];
  task.comments.push(comment);
  task.commentsCount = (task.commentsCount || 0) + 1;
  await task.save();
  const populated = await Task.findById(taskId)
    .populate({
      path: 'comments.commentedBy',
      select: 'name email',
    })
    .lean();
  const lastComment = (populated.comments || []).pop();
  return lastComment;
};

export {
  createTask,
  queryTasks,
  getTaskById,
  updateTaskById,
  updateTaskStatusById,
  deleteTaskById,
  getTaskComments,
  addTaskComment,
  parseCommaList,
  applyCommaFilter,
  expandPriorityFilterForDefaultMedium,
  sanitizeTaskWritePayload,
  enrichWithOffboarding,
};
