import Attendance from '../models/attendance.model.js';
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

const DAY = 86400000;
const EMPTY = { _id: { $in: [] } };

const toId = (v) => (v ? String(v._id || v.id || v) : '');
const utcMidnight = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/**
 * Maximal run of consecutive UTC days that includes today.
 * @param {number[]} dayMsList UTC-midnight epoch ms of leave days (any order, dups ok)
 * @param {number} todayMs UTC-midnight epoch ms of today
 * @returns {{ startMs: number, endMs: number }}
 */
export const contiguousRange = (dayMsList, todayMs) => {
  const days = new Set(dayMsList.map(Number));
  days.add(todayMs);
  let start = todayMs;
  let end = todayMs;
  while (days.has(start - DAY)) start -= DAY;
  while (days.has(end + DAY)) end += DAY;
  return { startMs: start, endMs: end };
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
    { student: 1 }
  ).lean();
  if (!todayLeaves.length) return { scope, results: [] };
  const onLeaveStudentIds = [...new Set(todayLeaves.map((l) => toId(l.student)))];

  // Contiguous leave block around today.
  // ponytail: ±31d window caps the span; widen if HR ever books leave blocks longer than a month.
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - 31);
  const windowEnd = new Date(today);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 31);
  const rangeRows = await Attendance.find(
    { student: { $in: onLeaveStudentIds }, status: 'Leave', date: { $gte: windowStart, $lt: windowEnd } },
    { student: 1, date: 1 }
  ).lean();

  const daysByStudent = new Map();
  for (const r of rangeRows) {
    const k = toId(r.student);
    if (!daysByStudent.has(k)) daysByStudent.set(k, []);
    daysByStudent.get(k).push(utcMidnight(r.date).getTime());
  }

  const ownerToEmployee = new Map(employees.map((e) => [toId(e.owner), e]));
  const todayMs = today.getTime();

  const result = [];
  for (const sid of onLeaveStudentIds) {
    const emp = ownerToEmployee.get(studentToOwner.get(sid));
    if (!emp) continue;
    const { startMs, endMs } = contiguousRange(daysByStudent.get(sid) || [todayMs], todayMs);
    result.push({
      employeeId: emp.employeeId || '',
      name: emp.fullName || emp.name || '',
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return { scope, results: result };
};

export { getEmployeesOnLeaveToday };
export default { getEmployeesOnLeaveToday, contiguousRange };
