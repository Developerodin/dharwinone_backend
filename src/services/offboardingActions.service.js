import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import EmailAccount from '../models/emailAccount.model.js';
import Task from '../models/task.model.js';
import User from '../models/user.model.js';
import TeamMember from '../models/team.model.js';
import { applyReassign } from './offboarding.pure.js';
import { evaluateOffboardingForEmployee } from './offboardingChecklist.service.js';

const REASON = 'offboarding';

const deactivateEmail = async (owner) => {
  if (!owner) return;
  await EmailAccount.updateMany({ user: owner, status: 'active' }, { $set: { status: 'revoked' } });
};

const reassignTasks = async (owner, toUserIds) => {
  if (!owner) return;
  if (!Array.isArray(toUserIds) || toUserIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'toUserIds is required to reassign tasks');
  }
  const now = new Date();
  const tasks = await Task.find({ assignedTo: owner, status: { $ne: 'completed' } }).select('assignedTo formerAssignees');
  for (const task of tasks) {
    const r = applyReassign(task, owner, toUserIds, REASON, now);
    if (!r.changed && r.assignedTo.length === task.assignedTo.length) continue;
    task.assignedTo = r.assignedTo;
    task.formerAssignees = r.formerAssignees;
    await task.save();
  }
};

/**
 * Users eligible to receive reassigned tasks. Served here (under employees.manage)
 * so the offboarding picker never needs the separate users.read permission.
 */
export const listAssignableUsers = async () => {
  const users = await User.find({ status: { $nin: ['deleted', 'disabled'] } })
    .select('name email')
    .sort({ name: 1 })
    .lean();
  return users.map((u) => ({ id: String(u._id), name: u.name || null, email: u.email || null }));
};

/** Open (non-completed) tasks the departing employee is still assigned to. */
export const listOpenTasksForEmployee = async (employeeId) => {
  const employee = await Employee.findById(employeeId).select('owner').lean();
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'Employee not found');
  if (!employee.owner) return [];
  const tasks = await Task.find({ assignedTo: employee.owner, status: { $ne: 'completed' } })
    .select('title taskCode status priority assignedTo')
    .populate('assignedTo', 'name email')
    .sort({ updatedAt: -1 })
    .lean();
  return tasks.map((t) => ({
    id: String(t._id),
    title: t.title,
    taskCode: t.taskCode || null,
    status: t.status,
    priority: t.priority,
    assignees: (t.assignedTo || []).map((u) => ({
      id: String(u._id ?? u),
      name: u.name || null,
      email: u.email || null,
    })),
  }));
};

const disableTeams = async (employeeId) => {
  await TeamMember.updateMany(
    { employeeId, isActive: true },
    { $set: { isActive: false, removedAt: new Date(), removedReason: REASON } }
  );
};

/**
 * Perform the side effect for one exit step, then return the recomputed offboarding status.
 * @param {string} employeeId
 * @param {string} stepKey - 'email_deactivated' | 'tasks_reassigned' | 'org_team_disabled'
 * @param {{ toUserIds?: string[] }} [body]
 */
export const runOffboardingStep = async (employeeId, stepKey, body = {}) => {
  const employee = await Employee.findById(employeeId).select('owner resignDate').lean();
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'Employee not found');
  if (!employee.resignDate) throw new ApiError(httpStatus.BAD_REQUEST, 'Employee has no resignation date set');

  switch (stepKey) {
    case 'email_deactivated':
      await deactivateEmail(employee.owner);
      break;
    case 'tasks_reassigned':
      await reassignTasks(employee.owner, body.toUserIds);
      break;
    case 'org_team_disabled':
      await disableTeams(employeeId);
      break;
    default:
      throw new ApiError(httpStatus.BAD_REQUEST, `Unknown or non-actionable step: ${stepKey}`);
  }

  return evaluateOffboardingForEmployee(employeeId);
};
