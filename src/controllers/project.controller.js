import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createProject,
  queryProjects,
  getProjectById,
  userCanReadProjectViaAssignedTask,
  updateProjectById,
  deleteProjectById,
} from '../services/project.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

/**
 * Global toJSON deletes createdAt/updatedAt. The project overview reads those
 * keys from GET /projects/:id and from the PATCH body it stores after a save.
 * Read them off the document first; toJSON will not put them back.
 */
const projectJsonWithTimestamps = (project) => {
  const createdAt = project.createdAt;
  const updatedAt = project.updatedAt;
  const json = project.toJSON();
  if (createdAt != null) json.createdAt = createdAt;
  if (updatedAt != null) json.updatedAt = updatedAt;
  return json;
};

const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const project = await createProject(createdById, req.body);
  res.status(httpStatus.CREATED).send(project);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search', 'status', 'priority', 'mine']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.apiPermissions = req.authContext?.permissions;

  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryProjects(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  }

  const isAdmin = req.user.platformSuperUser || await userIsAdmin(req.user);
  const isOwner = String(project.createdBy?._id || project.createdBy) === String(req.user.id || req.user._id);
  /** Anyone with projects.read (or projects.manage) granted via role gets the detail view. */
  const apiPerms = req.authContext?.permissions;
  const hasReadPerm = !!apiPerms && (apiPerms.has('projects.read') || apiPerms.has('projects.manage'));
  if (!isAdmin && !isOwner && !hasReadPerm) {
    const viaAssignedTask = await userCanReadProjectViaAssignedTask(project, req.user);
    if (!viaAssignedTask) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
    }
  }

  res.send(projectJsonWithTimestamps(project));
});

const update = catchAsync(async (req, res) => {
  const project = await updateProjectById(req.params.projectId, req.body, req.user);
  res.send(projectJsonWithTimestamps(project));
});

const remove = catchAsync(async (req, res) => {
  await deleteProjectById(req.params.projectId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, list, get, update, remove, projectJsonWithTimestamps };
