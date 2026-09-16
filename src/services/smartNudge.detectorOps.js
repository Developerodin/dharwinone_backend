import Placement from '../models/placement.model.js';
import Employee from '../models/employee.model.js';
import Task from '../models/task.model.js';
import LeaveRequest from '../models/leaveRequest.model.js';
import Role from '../models/role.model.js';
import User from '../models/user.model.js';
import { SITUATIONS, SCAN_LIMIT } from '../constants/smartNudge.situations.js';
import { dayStartUtc, daysBetweenUtc, isObjectIdHex, buildEvent, uniqueEvents } from './smartNudge.helpers.js';

/**
 * Load Employee rows for placement candidate ids.
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>}
 */
const loadCandidates = async (ids) => {
  if (!ids.length) return new Map();
  const docs = await Employee.find({ _id: { $in: ids } })
    .select('assignedAgent email owner fullName')
    .lean();
  return new Map(docs.map((e) => [String(e._id), e]));
};

/**
 * Placement still Pending after joiningDate.
 * @param {{ now?: Date, placements?: object[], employees?: Map<string, object> }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectJoiningOverdue = async ({ now = new Date(), placements, employees } = {}) => {
  const cfg = SITUATIONS.joining_overdue;
  const today = dayStartUtc(now);
  const docs =
    placements ||
    (await Placement.find({
      status: 'Pending',
      joiningDate: { $lt: today },
    })
      .select('createdBy candidate joiningDate job')
      .populate('job', 'title')
      .limit(SCAN_LIMIT)
      .lean());

  const candMap = employees || (await loadCandidates(docs.map((p) => p.candidate).filter(Boolean)));
  const events = [];
  for (const p of docs) {
    const days = daysBetweenUtc(today, p.joiningDate);
    const emp = candMap.get(String(p.candidate));
    const label = emp?.fullName || p.job?.title || 'a hire';
    const entityId = String(p._id);
    const recipients = [];
    if (isObjectIdHex(p.createdBy)) recipients.push({ userId: p.createdBy, audience: 'recruiter' });
    if (isObjectIdHex(emp?.assignedAgent)) {
      recipients.push({ userId: emp.assignedAgent, audience: 'agent' });
    }
    for (const r of recipients) {
      events.push(
        buildEvent({
          situation: 'joining_overdue',
          audience: r.audience,
          userId: r.userId,
          entityType: 'placement',
          entityId,
          days,
          label,
          link: '/ats/pre-boarding',
          relatedEntity: { type: 'placement', id: entityId },
          metadata: { navTarget: 'preboarding' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Incomplete pre-boarding tasks 3 days before joiningDate.
 * Honors suppressCandidateNotifications for the candidate only.
 * @param {{ now?: Date, placements?: object[], employees?: Map<string, object> }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectPreboardIncomplete = async ({ now = new Date(), placements, employees } = {}) => {
  const cfg = SITUATIONS.preboard_incomplete;
  const docs =
    placements ||
    (await Placement.find({
      status: { $in: ['Pending', 'Onboarding'] },
      joiningDate: { $exists: true, $ne: null },
    })
      .select('createdBy candidate joiningDate preBoardingTasks suppressCandidateNotifications job')
      .populate('job', 'title')
      .limit(SCAN_LIMIT)
      .lean());

  const candMap = employees || (await loadCandidates(docs.map((p) => p.candidate).filter(Boolean)));
  const events = [];
  for (const p of docs) {
    const d = daysBetweenUtc(p.joiningDate, now);
    if (d !== cfg.daysBeforeJoin) continue;
    const tasks = p.preBoardingTasks || [];
    if (!tasks.length || tasks.every((t) => t.done)) continue;
    const emp = candMap.get(String(p.candidate));
    const label = emp?.fullName || p.job?.title || 'pre-boarding';
    const entityId = String(p._id);

    if (isObjectIdHex(p.createdBy)) {
      events.push(
        buildEvent({
          situation: 'preboard_incomplete',
          audience: 'recruiter',
          userId: p.createdBy,
          entityType: 'placement',
          entityId,
          days: d,
          label,
          link: '/ats/pre-boarding',
          relatedEntity: { type: 'placement', id: entityId },
          metadata: { navTarget: 'preboarding' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
    if (!p.suppressCandidateNotifications) {
      events.push(
        buildEvent({
          situation: 'preboard_incomplete',
          audience: 'candidate',
          userId: isObjectIdHex(emp?.owner) ? emp.owner : null,
          email: emp?.email,
          entityType: 'placement',
          entityId,
          days: d,
          label: p.job?.title || 'your joining',
          link: '/ats/my-profile',
          relatedEntity: { type: 'placement', id: entityId },
          metadata: { navTarget: 'onboarding' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Tasks past dueDate that are not completed.
 * @param {{ now?: Date, tasks?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectTaskOverdue = async ({ now = new Date(), tasks } = {}) => {
  const cfg = SITUATIONS.task_overdue;
  const docs =
    tasks ||
    (await Task.find({
      dueDate: { $lt: now },
      status: { $ne: 'completed' },
    })
      .select('title assignedTo dueDate')
      .limit(SCAN_LIMIT)
      .lean());

  const events = [];
  for (const t of docs) {
    const days = daysBetweenUtc(now, t.dueDate);
    const label = t.title || 'Task';
    for (const uid of t.assignedTo || []) {
      events.push(
        buildEvent({
          situation: 'task_overdue',
          audience: 'employee',
          userId: uid,
          entityType: 'task',
          entityId: String(t._id),
          days,
          label,
          link: '/task/my-tasks',
          relatedEntity: { type: 'task', id: String(t._id) },
          metadata: { taskId: String(t._id), navTarget: 'tasks' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Leave requests pending longer than the stale window → Administrators.
 * @param {{ now?: Date, requests?: object[], adminIds?: string[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectLeavePendingStale = async ({ now = new Date(), requests, adminIds } = {}) => {
  const cfg = SITUATIONS.leave_pending_stale;
  const staleBefore = new Date(now.getTime() - cfg.staleDays * 24 * 60 * 60 * 1000);
  const docs =
    requests ||
    (await LeaveRequest.find({
      status: 'pending',
      createdAt: { $lte: staleBefore },
    })
      .select('studentEmail createdAt leaveType')
      .limit(SCAN_LIMIT)
      .lean());
  if (!docs.length) return [];

  let admins = adminIds;
  if (!admins) {
    const adminRole = await Role.findOne({ name: 'Administrator', status: 'active' }).select('_id').lean();
    if (!adminRole) return [];
    const users = await User.find({ roleIds: adminRole._id, status: 'active' }).select('_id').limit(50).lean();
    admins = users.map((u) => String(u._id));
  }
  if (!admins.length) return [];

  const events = [];
  for (const req of docs) {
    const days = daysBetweenUtc(now, req.createdAt);
    const label = req.studentEmail || 'a student';
    for (const uid of admins) {
      events.push(
        buildEvent({
          situation: 'leave_pending_stale',
          audience: 'admin',
          userId: uid,
          entityType: 'leave_request',
          entityId: String(req._id),
          days,
          label,
          link: '/settings/attendance/leave-requests',
          relatedEntity: { type: 'leave_request', id: String(req._id) },
          metadata: { navTarget: 'leave' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};
