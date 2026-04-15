import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Project from '../models/project.model.js';
import Task from '../models/task.model.js';
import AssignmentRun from '../models/assignmentRun.model.js';
import TaskBreakdownIdempotency from '../models/taskBreakdownIdempotency.model.js';
import TeamGroup from '../models/teamGroup.model.js';
import ApiError from '../utils/ApiError.js';
import { buildSpecialistTaskSlugOrConditions } from '../constants/candidateProjectTaskTypes.js';
import { userIsAdmin, userHasCandidateRole } from '../utils/roleHelpers.js';

/** Safe substring search — user input is literal, not a RegExp pattern. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createProject = async (createdById, payload) => {
  const project = await Project.create({
    createdBy: createdById,
    ...payload,
  });
  await project.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'assignedTo', select: 'name email' },
    { path: 'assignedTeams', select: 'name' },
  ]);
  const assigneeIds = [...new Set((project.assignedTo || []).map((u) => String(u._id || u)).filter(Boolean))];
  if (assigneeIds.length) {
    const { notify } = await import('./notification.service.js');
    const link = `/projects/${project._id}`;
    const title = 'Project assigned';
    const message = `You have been assigned to project "${project.name}".`;
    for (const userId of assigneeIds) {
      notify(userId, { type: 'project', title, message, link }).catch(() => {});
    }
  }
  return project;
};

const queryProjects = async (filter, options) => {
  if (filter.search) {
    const raw = String(filter.search).trim();
    if (raw) {
      const searchRegex = new RegExp(escapeRegex(raw), 'i');
      const teamMatches = await TeamGroup.find({ name: searchRegex }).select('_id').limit(300).lean();
      const teamIds = teamMatches.map((t) => t._id).filter(Boolean);

      filter.$or = [
        { name: searchRegex },
        { description: searchRegex },
        { projectManager: searchRegex },
        { clientStakeholder: searchRegex },
        { tags: searchRegex },
        ...(teamIds.length ? [{ assignedTeams: { $in: teamIds } }] : []),
      ];
    }
    delete filter.search;
  }

  const isAdmin = await userIsAdmin({ roleIds: filter.userRoleIds || [] });
  const userId = filter.userId;
  const userRoleIds = filter.userRoleIds || [];
  const mineOnly =
    filter.mine === true || filter.mine === 'true' || filter.mine === '1' || filter.mine === 1;
  delete filter.mine;

  const searchDisjunction = filter.$or;
  const hasSearchDisjunction = Array.isArray(searchDisjunction) && searchDisjunction.length > 0;
  if (hasSearchDisjunction) {
    delete filter.$or;
  }

  if (!isAdmin && userId) {
    const isCandidate = await userHasCandidateRole({ roleIds: userRoleIds });
    if (isCandidate && mongoose.Types.ObjectId.isValid(String(userId))) {
      const userOid = new mongoose.Types.ObjectId(String(userId));
      /** My Projects (?mine=1): any assigned task. Main Projects list: specialist-slug tasks only. */
      const taskProjectFilter = mineOnly
        ? { assignedTo: userOid, projectId: { $ne: null } }
        : {
            assignedTo: userOid,
            projectId: { $ne: null },
            $or: buildSpecialistTaskSlugOrConditions(),
          };
      const projectIdsFromTasks = await Task.distinct('projectId', taskProjectFilter).exec();
      const idList = (projectIdsFromTasks || []).filter(Boolean);
      const accessOr = [{ createdBy: userId }, { _id: { $in: idList } }];
      if (hasSearchDisjunction) {
        filter.$and = [{ $or: searchDisjunction }, { $or: accessOr }];
      } else {
        filter.$or = accessOr;
      }
    } else if (hasSearchDisjunction) {
      filter.$and = [{ $or: searchDisjunction }, { createdBy: userId }];
    } else {
      filter.createdBy = userId;
    }
  } else if (isAdmin && mineOnly && userId) {
    if (hasSearchDisjunction) {
      filter.$and = [{ $or: searchDisjunction }, { createdBy: userId }];
    } else {
      filter.createdBy = userId;
    }
  } else if (hasSearchDisjunction) {
    filter.$or = searchDisjunction;
  }

  delete filter.userRoleIds;
  delete filter.userId;

  const result = await Project.paginate(filter, options);

  if (result.results && result.results.length > 0) {
    for (const doc of result.results) {
      await doc.populate([
        { path: 'createdBy', select: 'name email' },
        { path: 'assignedTo', select: 'name email' },
        { path: 'assignedTeams', select: 'name' },
      ]);
    }
  }

  return result;
};

const getProjectById = async (id) => {
  const project = await Project.findById(id).exec();
  if (!project) return null;

  await project.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'assignedTo', select: 'name email' },
    { path: 'assignedTeams', select: 'name' },
  ]);

  return project;
};

/**
 * Any user with a task assigned on this project may read it (e.g. My Tasks → project context).
 * Candidate project *list* remains restricted to specialist-slug tasks in queryProjects.
 */
const userCanReadProjectViaAssignedTask = async (project, user) => {
  if (!project?._id || !user) return false;
  const uid = user.id || user._id;
  if (!mongoose.Types.ObjectId.isValid(String(uid))) return false;
  const userOid = new mongoose.Types.ObjectId(String(uid));
  return !!(await Task.exists({
    projectId: project._id,
    assignedTo: userOid,
  }).exec());
};

const updateProjectById = async (id, updateBody, currentUser) => {
  const project = await getProjectById(id);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, project);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const oldAssigneeIds = new Set((project.assignedTo || []).map((u) => String(u._id || u)).filter(Boolean));
  Object.assign(project, updateBody);
  await project.save();

  await project.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'assignedTo', select: 'name email' },
    { path: 'assignedTeams', select: 'name' },
  ]);

  const newAssigneeIds = [...new Set((project.assignedTo || []).map((u) => String(u._id || u)).filter(Boolean))];
  const addedIds = newAssigneeIds.filter((uid) => !oldAssigneeIds.has(uid));
  if (addedIds.length) {
    const { notify } = await import('./notification.service.js');
    const link = `/projects/${project._id}`;
    const title = 'Project assigned';
    const message = `You have been assigned to project "${project.name}".`;
    for (const userId of addedIds) {
      notify(userId, { type: 'project', title, message, link }).catch(() => {});
    }
  }

  return project;
};

const deleteProjectById = async (id, currentUser) => {
  const project = await getProjectById(id);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  }
  const canDelete = await isOwnerOrAdmin(currentUser, project);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const projectOid = project._id;
  await Promise.all([
    Task.deleteMany({ projectId: projectOid }),
    TaskBreakdownIdempotency.deleteMany({ projectId: projectOid }),
    AssignmentRun.deleteMany({ projectId: projectOid }),
  ]);
  await project.deleteOne();
  return project;
};

export {
  createProject,
  queryProjects,
  getProjectById,
  userCanReadProjectViaAssignedTask,
  updateProjectById,
  deleteProjectById,
};
