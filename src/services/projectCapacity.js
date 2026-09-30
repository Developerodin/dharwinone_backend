import mongoose from 'mongoose';
import ProjectModel from '../models/project.model.js';

/**
 * The PM assistant's staffing rule, in one place: a person who is already a project assignee
 * (Project.assignedTo) on MAX_ACTIVE_PROJECTS_PER_ASSIGNEE other active projects cannot be added to
 * another one, unless they are already on it. pmAssistant.service (generate + apply) and Sage's
 * get_allocation both read it from here.
 */
export const ACTIVE_PROJECT_STATUSES = Object.freeze(['Inprogress', 'On hold']);
export const MAX_ACTIVE_PROJECTS_PER_ASSIGNEE = 2;

const toOidIfValid = (id) =>
  mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : id;

export function isAtProjectCapacity(activeElsewhere, { alreadyOnProject = false } = {}) {
  return !alreadyOnProject && activeElsewhere >= MAX_ACTIVE_PROJECTS_PER_ASSIGNEE;
}

/** Project filter: active projects, minus excludeProjectId when given. */
export function activeProjectsFilter(excludeProjectId) {
  return {
    ...(excludeProjectId != null ? { _id: { $ne: toOidIfValid(excludeProjectId) } } : {}),
    status: { $in: [...ACTIVE_PROJECT_STATUSES] },
  };
}

/**
 * userId → number of active projects that list them in assignedTo (excluding excludeProjectId).
 * Every requested id is in the map; invalid ids and people on no project map to 0.
 * ponytail: one $unwind aggregate over active projects; fine while active projects are in the
 * thousands. Past that, index assignedTo+status and $match on assignedTo before the $unwind.
 */
export async function countActiveProjectsByAssignee(userIds, { excludeProjectId } = {}, deps = {}) {
  const Project = deps.Project ?? ProjectModel;
  const unique = [...new Set((userIds || []).map((id) => String(id)).filter(Boolean))];
  const counts = new Map(unique.map((id) => [id, 0]));
  const oids = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (oids.length === 0) return counts;

  const rows = await Project.aggregate([
    { $match: activeProjectsFilter(excludeProjectId) },
    { $unwind: '$assignedTo' },
    { $match: { assignedTo: { $in: oids } } },
    { $group: { _id: '$assignedTo', cnt: { $sum: 1 } } },
  ]);
  for (const r of rows) counts.set(String(r._id), r.cnt);
  return counts;
}
