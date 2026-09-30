import Joi from 'joi';
import EmployeeModel from '../../../../../models/employee.model.js';
import StudentModel from '../../../../../models/student.model.js';
import UserModel from '../../../../../models/user.model.js';
import LeaveRequestModel from '../../../../../models/leaveRequest.model.js';
import { getGrantingPermissions } from '../../../../../config/permissions.js';
import attendanceService from '../../../../attendance.service.js';
import {
  buildLeaveRequestScopeFilter as realBuildLeaveRequestScopeFilter,
  queryLeaveRequests as realQueryLeaveRequests,
} from '../../../../leaveRequest.service.js';
import { queryBackdatedAttendanceRequests as realQueryBackdated } from '../../../../backdatedAttendanceRequest.service.js';
import { getEmployeesOnLeaveToday as realGetEmployeesOnLeaveToday } from '../../../../onLeaveToday.service.js';
import { aggregateOrgAttendance as realAggregateOrgAttendance } from '../../../attendanceAggregator.js';
import { dayRange } from '../employees/common.js';
import { ownsProfile } from '../ownsProfile.js';

export const MAX_LIST_LIMIT = 50;
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
export const LEAVE_TYPES = ['casual', 'sick', 'unpaid'];

// Leave Requests / Backdated / On-leave-today pages: auth only, rows graded by the service
// (admin/agent or reviewer → company, everyone else → own). Self attendance is always allowed.
export const LEAVE_ACCESS = Object.freeze({ note: 'leaveRequest.service buildLeaveRequestScopeFilter' });
export const BACKDATED_ACCESS = Object.freeze({ note: 'backdatedAttendanceRequest.service canReviewRequests / own' });
export const ON_LEAVE_TODAY_ACCESS = Object.freeze({ note: 'onLeaveToday.service dashboard.manage / dashboard.view / self' });
export const ATTENDANCE_ACCESS = Object.freeze({
  note: 'self always; another person needs students.read/manage or candidates.read/manage (requireAttendanceAccess)',
});
// Attendance → Track page (attendance.route.js GET /track): students.manage.
export const ATTENDANCE_SUMMARY_ACCESS = Object.freeze({ anyOf: ['students.manage'] });

// Who may name ANOTHER person in a leave / backdated question. Rows stay scoped by the page's
// service either way; this only stops a plain employee using name lookup to probe the roster.
const OTHER_PERSON_PERMISSIONS = ['students.read', 'students.manage', 'candidates.read', 'candidates.manage',
  'employees.read', 'attendance.assign'];
// requireAttendanceAccess / requireUserAttendanceView: another person's attendance rows.
const OTHER_ATTENDANCE_PERMISSIONS = ['students.read', 'students.manage', 'candidates.read', 'candidates.manage'];

export const windowSchema = Joi.object({
  from: Joi.string().min(10).max(10).required().description('First day, YYYY-MM-DD (inclusive).'),
  to: Joi.string().min(10).max(10).required().description('Last day, YYYY-MM-DD (inclusive).'),
});

export const personSchema = Joi.string().min(1)
  .description('A named person (full name, employee id like DBS10, email, or user id). Omit for the signed-in ' +
    'user\'s own records. NEVER a pronoun — resolve it from the conversation first.');

export function attendanceScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('attendance tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function attendanceDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    Employee: deps.Employee ?? EmployeeModel,
    Student: deps.Student ?? StudentModel,
    User: deps.User ?? UserModel,
    LeaveRequest: deps.LeaveRequest ?? LeaveRequestModel,
    listByStudent: deps.listByStudent ?? attendanceService.listByStudent,
    listByUser: deps.listByUser ?? attendanceService.listByUser,
    buildLeaveRequestScopeFilter: deps.buildLeaveRequestScopeFilter ?? realBuildLeaveRequestScopeFilter,
    queryLeaveRequests: deps.queryLeaveRequests ?? realQueryLeaveRequests,
    queryBackdatedAttendanceRequests: deps.queryBackdatedAttendanceRequests ?? realQueryBackdated,
    getEmployeesOnLeaveToday: deps.getEmployeesOnLeaveToday ?? realGetEmployeesOnLeaveToday,
    aggregateOrgAttendance: deps.aggregateOrgAttendance ?? realAggregateOrgAttendance,
  };
}

const userIdOf = (user) => String(user?.id ?? user?._id ?? '');

function hasAnyGranting(user, required) {
  if (user?.platformSuperUser) return true;
  const perms = user?.authContext?.permissions;
  return !!perms && required.some((r) => getGrantingPermissions(r).some((p) => perms.has(p)));
}

export const canNameOthers = (user) => hasAnyGranting(user, OTHER_PERSON_PERMISSIONS);
export const canViewOthersAttendance = (user) => hasAnyGranting(user, OTHER_ATTENDANCE_PERMISSIONS);

/**
 * { from, to } (YYYY-MM-DD) → UTC-midnight Date keys. dayRange (employees/common.js) is the shared
 * validator — it throws on a bad day. Its instants are not used: Attendance.date, LeaveRequest.dates
 * and attendanceEntries.date are DAY KEYS stored at UTC midnight, so an offset instant would shift
 * the window by a day.
 */
export function dayKeys(window) {
  if (!window) return null;
  dayRange('window', window);
  const from = new Date(`${window.from}T00:00:00.000Z`);
  const to = new Date(`${window.to}T00:00:00.000Z`);
  if (from > to) throw new Error('window.from must be on or before window.to.');
  return { from, to };
}

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Resolve a named person to their user id + Student ids. Omitted → the viewer. Returns { error },
 * { notFound }, { matches } (ambiguous), or { person: { userId, name, employeeId, self, studentIds } }.
 */
export async function resolvePerson(person, user, deps, { canName = canNameOthers } = {}) {
  const selfId = userIdOf(user);
  const studentIdsFor = async (uid) => (await deps.Student.find({ user: uid }).select('_id').lean()).map((s) => s._id);
  if (!person) {
    return { person: { userId: selfId, name: user.name ?? null, self: true, studentIds: await studentIdsFor(selfId) } };
  }
  if (!canName(user)) {
    return { error: 'You can only see your own records here. Ask about "my" attendance or leave instead.' };
  }
  const q = String(person).trim();
  if (/^[a-f0-9]{24}$/i.test(q)) {
    // A user id (e.g. from get_user): attendance and leave hang off the login, so no profile hop is needed.
    const u = await deps.User.findById(q).select('name').lean();
    if (!u) return { notFound: q };
    const emp = await deps.Employee.findOne({ owner: q }).select('owner email employeeId').lean();
    const own = emp && (await ownsProfile([emp], deps))(emp);
    return {
      person: {
        userId: q, name: u.name ?? null, employeeId: own ? emp.employeeId ?? null : null,
        self: q === selfId, studentIds: await studentIdsFor(q),
      },
    };
  }
  const exact = new RegExp(`^${escapeRegex(q)}$`, 'i');
  const found = await deps.Employee.find({
    owner: { $ne: null },
    $or: [{ fullName: { $regex: escapeRegex(q), $options: 'i' } }, { employeeId: exact }, { email: exact }],
  }).select('owner fullName employeeId email').limit(6).lean();
  // A candidate profile the job creator merely owns is not the creator: resolving through it would show the
  // recruiter's attendance and leave under the candidate's name.
  const owns = await ownsProfile(found, deps);
  const rows = found.filter(owns);
  if (!rows.length) return { notFound: q };
  const exactRows = rows.filter((r) => exact.test(r.fullName || '') || exact.test(r.employeeId || ''));
  let picked = null;
  if (exactRows.length === 1) [picked] = exactRows;
  else if (rows.length === 1) [picked] = rows;
  if (!picked) {
    return { matches: rows.map((r) => ({ name: r.fullName ?? null, employeeId: r.employeeId ?? null })) };
  }
  const uid = String(picked.owner);
  return {
    person: {
      userId: uid,
      name: picked.fullName ?? null,
      employeeId: picked.employeeId ?? null,
      self: uid === selfId,
      studentIds: await studentIdsFor(uid),
    },
  };
}

/** Non-person outcome of resolvePerson → a tool result, or null when a person was resolved. */
export function personMiss(res, filtersApplied) {
  if (res.error) return { error: res.error };
  if (res.notFound) return { notFound: 'person', searchedFor: res.notFound, total: 0, records: [], filtersApplied };
  if (res.matches) return { matches: res.matches, total: 0, records: [], filtersApplied };
  return null;
}

export function countFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}

export function simpleTable({ id, title, columns, rows }) {
  return {
    type: 'table',
    id,
    tableType: id,
    title,
    columns: columns.map(([key, label, priority = 'primary']) => ({ key, label, priority })),
    rows: rows.map((r) => Object.fromEntries(columns.map(([key]) => [key, r[key] ?? '—']))),
    layout: 'auto',
  };
}

export const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
