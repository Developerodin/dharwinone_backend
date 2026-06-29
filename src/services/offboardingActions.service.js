import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import EmailAccount from '../models/emailAccount.model.js';
import Task from '../models/task.model.js';
import User from '../models/user.model.js';
import TeamMember from '../models/team.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import BackdatedAttendanceRequest from '../models/backdatedAttendanceRequest.model.js';
import { applyReassign } from './offboarding.pure.js';
import { evaluateOffboardingForEmployee, buildActiveTeamFilter, backdatedRequestMatch } from './offboardingChecklist.service.js';

const REASON = 'offboarding';

const deactivateEmail = async (owner, employeeId) => {
  if (owner) {
    await EmailAccount.updateMany({ user: owner, status: 'active' }, { $set: { status: 'revoked' } });
  }
  // Strip the company-assigned address off the employee so the step reflects a real change.
  // Reset the provider to '' (Auto-detect) too, so the roster doesn't keep showing the
  // provider of the mailbox that was just removed.
  if (employeeId) {
    await Employee.updateOne({ _id: employeeId }, { $set: { companyAssignedEmail: '', companyEmailProvider: '' } });
  }
};

const saveReassign = async (task, owner, toUserIds, now) => {
  const r = applyReassign(task, owner, toUserIds, REASON, now);
  if (!r.changed && r.assignedTo.length === task.assignedTo.length) return;
  task.assignedTo = r.assignedTo;
  task.formerAssignees = r.formerAssignees;
  await task.save();
};

const reassignTasks = async (owner, { toUserIds, assignments } = {}) => {
  if (!owner) return;
  const now = new Date();

  // Per-task mode: each entry routes one task to its own recipients.
  if (Array.isArray(assignments) && assignments.length > 0) {
    const ids = assignments.map((a) => a.taskId);
    const tasks = await Task.find({ _id: { $in: ids }, assignedTo: owner, status: { $ne: 'completed' } }).select(
      'assignedTo formerAssignees'
    );
    const byId = new Map(tasks.map((t) => [String(t._id), t]));
    for (const { taskId, toUserIds: to } of assignments) {
      const task = byId.get(String(taskId));
      if (!task || !Array.isArray(to) || to.length === 0) continue;
      await saveReassign(task, owner, to, now);
    }
    return;
  }

  // Bulk mode: every open task to the same recipients.
  if (!Array.isArray(toUserIds) || toUserIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'toUserIds or assignments is required to reassign tasks');
  }
  const tasks = await Task.find({ assignedTo: owner, status: { $ne: 'completed' } }).select('assignedTo formerAssignees');
  for (const task of tasks) {
    await saveReassign(task, owner, toUserIds, now);
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

/** All backdated-attendance requests (pending + historical) for the departing employee (user-based). */
export const listBackdatedRequestsForEmployee = async (employeeId) => {
  const employee = await Employee.findById(employeeId).select('owner email').lean();
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'Employee not found');
  const reqs = await BackdatedAttendanceRequest.find(backdatedRequestMatch(employee))
    .select('attendanceEntries notes status adminComment requestedBy reviewedBy reviewedAt createdAt')
    .populate('requestedBy', 'name email')
    .populate('reviewedBy', 'name email')
    .sort({ createdAt: -1 })
    .lean();
  return reqs.map((r) => ({
    id: String(r._id),
    attendanceEntries: (r.attendanceEntries || []).map((e) => ({
      date: e.date,
      punchIn: e.punchIn,
      punchOut: e.punchOut ?? null,
      timezone: e.timezone || null,
    })),
    notes: r.notes ?? null,
    status: r.status,
    adminComment: r.adminComment ?? null,
    requestedByName: r.requestedBy?.name || r.requestedBy?.email || null,
    reviewedByName: r.reviewedBy?.name || r.reviewedBy?.email || null,
    reviewedAt: r.reviewedAt ?? null,
    createdAt: r.createdAt,
  }));
};

const disableTeamsAndOrg = async (employee) => {
  // Archive linked AND orphan/legacy team memberships (matched by email).
  await TeamMember.updateMany(
    buildActiveTeamFilter(employee),
    { $set: { isActive: false, removedAt: new Date(), removedReason: REASON } }
  );
  // Detach from the org structure now (the scheduler would otherwise only drop the node
  // on the last working day): clear department membership and any unit-head roles.
  await Employee.updateOne({ _id: employee._id }, { $set: { departmentId: null, department: '' } });
  await OrgUnit.updateMany({ headEmployeeId: employee._id }, { $set: { headEmployeeId: null } });
};

/**
 * Perform the side effect for one exit step, then return the recomputed offboarding status.
 * @param {string} employeeId
 * @param {string} stepKey - 'email_deactivated' | 'tasks_reassigned' | 'org_team_disabled'
 * @param {{ toUserIds?: string[] }} [body]
 */
export const runOffboardingStep = async (employeeId, stepKey, body = {}) => {
  const employee = await Employee.findById(employeeId).select('owner email resignDate').lean();
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'Employee not found');
  if (!employee.resignDate) throw new ApiError(httpStatus.BAD_REQUEST, 'Employee has no resignation date set');

  switch (stepKey) {
    case 'email_deactivated':
      await deactivateEmail(employee.owner, employeeId);
      break;
    case 'tasks_reassigned':
      await reassignTasks(employee.owner, body);
      break;
    case 'org_team_disabled':
      await disableTeamsAndOrg(employee);
      break;
    default:
      throw new ApiError(httpStatus.BAD_REQUEST, `Unknown or non-actionable step: ${stepKey}`);
  }

  return evaluateOffboardingForEmployee(employeeId);
};
