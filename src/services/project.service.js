import httpStatus from 'http-status';
import Project from '../models/project.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

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
  return project;
};

const queryProjects = async (filter, options) => {
  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    filter.$or = [
      { name: searchRegex },
      { description: searchRegex },
      { projectManager: searchRegex },
      { clientStakeholder: searchRegex },
      { tags: searchRegex },
    ];
    delete filter.search;
  }

  const isAdmin = await userIsAdmin({ roleIds: filter.userRoleIds || [] });
  if (!isAdmin && filter.userId) {
    const userId = filter.userId;
    filter.createdBy = userId;
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

const updateProjectById = async (id, updateBody, currentUser) => {
  const project = await getProjectById(id);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, project);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  Object.assign(project, updateBody);
  await project.save();

  await project.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'assignedTo', select: 'name email' },
    { path: 'assignedTeams', select: 'name' },
  ]);

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

  await project.deleteOne();
  return project;
};

export {
  createProject,
  queryProjects,
  getProjectById,
  updateProjectById,
  deleteProjectById,
};
