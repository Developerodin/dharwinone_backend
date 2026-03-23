import httpStatus from 'http-status';
import Task from '../models/task.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createTask = async (createdById, payload) => {
  const task = await Task.create({
    createdBy: createdById,
    ...payload,
  });
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
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

const queryTasks = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    filter.$or = [
      { title: searchRegex },
      { description: searchRegex },
      { taskCode: searchRegex },
      { tags: searchRegex },
    ];
    delete filter.search;
  }

  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds;
  const assignedToMe = filter.assignedToMe === true || filter.assignedToMe === 'true';
  delete filter.userRoleIds;
  delete filter.userId;
  delete filter.assignedToMe;

  const isAdmin = await userIsAdmin({ roleIds: userRoleIds || [] });
  let finalFilter = { ...filter };
  
  if (assignedToMe && userId) {
    // Show only tasks assigned to the current user
    finalFilter.assignedTo = userId;
  } else if (!isAdmin && userId) {
    // Show tasks created by or assigned to the current user
    finalFilter = {
      $and: [
        finalFilter,
        { $or: [{ createdBy: userId }, { assignedTo: userId }] },
      ],
    };
  }

  const sort = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 100;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    Task.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([{ path: 'createdBy', select: 'name email' }, { path: 'projectId', select: 'name' }])
      .exec(),
    Task.countDocuments(finalFilter).exec(),
  ]);

  const totalPages = Math.ceil(totalResults / limit);
  return { results, page, limit, totalPages, totalResults };
};

const getTaskById = async (id) => {
  const task = await Task.findById(id).exec();
  if (!task) return null;
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
    { path: 'comments.commentedBy', select: 'name email' },
  ]);
  return task;
};

const updateTaskById = async (id, updateBody, currentUser) => {
  const task = await getTaskById(id);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, task);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const prevAssigned = new Set((task.assignedTo || []).map((u) => String(u._id || u)));
  Object.assign(task, updateBody);
  await task.save();
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
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
  const canUpdate = await isOwnerOrAdmin(currentUser, task);
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
  await task.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'projectId', select: 'name' },
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
  const canDelete = await isOwnerOrAdmin(currentUser, task);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  await task.deleteOne();
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
  const allowed = admin || canCommentOnTask(task, currentUser.id || currentUser._id);
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
  const allowed = admin || canCommentOnTask(task, userId);
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
};
