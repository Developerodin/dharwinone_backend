import Attendance from '../models/attendance.model.js';
import LeaveRequest from '../models/leaveRequest.model.js';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';
import { hasApiPermission } from '../utils/permissionCheck.js';

/**
 * "On leave today" dashboard widget. Visibility is graded by the General → Dashboard
 * permission row (general.dashboard:* — see permissionAliases in config/permissions.js):
 *   - dashboard.manage (all four: view+create+edit+delete) -> every employee on leave
 *   - dashboard.view only                                   -> only employees they referred
 *   - neither (plain employee)                              -> only themselves
 *
 * Leave lives on Attendance(status:'Leave') keyed by Student, while the DBSxxx
 * code lives on Employee. Bridge: Attendance.student -> Student.user(User) <- Employee.owner.
 */

const EMPTY = { _id: { $in: [] } };

const toId = (v) => (v ? String(v._id || v.id || v) : '');
const utcMidnight = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/**
 * Overall span (min..max UTC-midnight ms) of a leave request's discrete dates.
 * Leave is booked as discrete weekday dates (weekends skipped), so the request's
 * true span is its earliest..latest date — NOT a calendar-contiguous run, which
 * would break at every weekend gap.
 * @param {(Date|number|string)[]} dates discrete leave dates (any order)
 * @param {number} fallbackMs returned for an empty list (today)
 * @returns {{ startMs: number, endMs: number }}
 */
export const spanFromDates = (dates, fallbackMs) => {
  const ms = (dates || []).map((d) => utcMidnight(d).getTime());
  if (!ms.length) return { startMs: fallbackMs, endMs: fallbackMs };
  return { startMs: Math.min(...ms), endMs: Math.max(...ms) };
};

/** Employee filter + scope label for which employees this actor may see on leave. */
const employeeScope = async (actor) => {
  if (await hasApiPermission(actor, 'dashboard.manage')) return { filter: {}, scope: 'all' }; // all four -> everyone
  const actorId = toId(actor && (actor._id || actor.id));
  if (await hasApiPermission(actor, 'dashboard.view')) {
    return { filter: actorId ? { referredByUserId: actorId } : EMPTY, scope: 'referrals' }; // view-only -> referrals
  }
  return { filter: actorId ? { owner: actorId } : EMPTY, scope: 'self' }; // plain employee -> self
};

const getEmployeesOnLeaveToday = async (actor) => {
  const today = utcMidnight(new Date());
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const { filter, scope } = await employeeScope(actor);
  const employees = await Employee.find(filter, { employeeId: 1, fullName: 1, name: 1, owner: 1 }).lean();
  if (!employees.length) return { scope, results: [] };

  const ownerIds = [...new Set(employees.map((e) => toId(e.owner)).filter(Boolean))];
  const students = await Student.find({ user: { $in: ownerIds } }, { user: 1 }).lean();
  if (!students.length) return { scope, results: [] };

  const studentToOwner = new Map(students.map((s) => [toId(s._id), toId(s.user)]));
  const studentIds = students.map((s) => s._id);

  // Who is on leave TODAY.
  const todayLeaves = await Attendance.find(
    { student: { $in: studentIds }, status: 'Leave', date: { $gte: today, $lt: tomorrow } },
    { student: 1, leaveType: 1 }
  ).lean();
  if (!todayLeaves.length) return { scope, results: [] };
  const onLeaveStudentIds = [...new Set(todayLeaves.map((l) => toId(l.student)))];

  // casual | sick | unpaid, straight off the Attendance row. A student can in
  // principle hold more than one Leave row for the day, so keep the types
  // distinct instead of letting the last row win.
  const leaveTypesByStudent = new Map();
  for (const l of todayLeaves) {
    if (!l.leaveType) continue;
    const k = toId(l.student);
    if (!leaveTypesByStudent.has(k)) leaveTypesByStudent.set(k, new Set());
    leaveTypesByStudent.get(k).add(l.leaveType);
  }

  // Real span = the approved LeaveRequest covering today (same data the request card shows).
  // Leave is booked as discrete weekday dates, so reconstructing a range from per-day
  // Attendance rows breaks at every weekend; use the request's own min..max instead.
  const requests = await LeaveRequest.find(
    { student: { $in: onLeaveStudentIds }, status: 'approved', dates: { $elemMatch: { $gte: today, $lt: tomorrow } } },
    { student: 1, dates: 1 }
  ).lean();

  const todayMs = today.getTime();
  const spanByStudent = new Map();
  for (const req of requests) {
    const { startMs, endMs } = spanFromDates(req.dates, todayMs);
    const k = toId(req.student);
    const prev = spanByStudent.get(k);
    spanByStudent.set(
      k,
      prev ? { startMs: Math.min(prev.startMs, startMs), endMs: Math.max(prev.endMs, endMs) } : { startMs, endMs }
    );
  }

  const ownerToEmployee = new Map(employees.map((e) => [toId(e.owner), e]));

  const result = [];
  for (const sid of onLeaveStudentIds) {
    const emp = ownerToEmployee.get(studentToOwner.get(sid));
    if (!emp) continue;
    const { startMs, endMs } = spanByStudent.get(sid) || { startMs: todayMs, endMs: todayMs };
    const types = [...(leaveTypesByStudent.get(sid) || [])].sort();
    result.push({
      employeeId: emp.employeeId || '',
      name: emp.fullName || emp.name || '',
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
      leaveType: types.length ? types.join(', ') : null,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return { scope, results: result };
};

export { getEmployeesOnLeaveToday };
export default { getEmployeesOnLeaveToday, spanFromDates };
