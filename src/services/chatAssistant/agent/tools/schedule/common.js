import EmployeeModel from '../../../../../models/employee.model.js';
import StudentModel from '../../../../../models/student.model.js';
import { queryShifts as realQueryShifts, queryShiftAssignees as realQueryShiftAssignees } from '../../../../shift.service.js';
import { queryHolidays as realQueryHolidays } from '../../../../holiday.service.js';
import { EMPLOYEE_QUERY_READ_PERMISSIONS } from '../../../../../schemas/employees/employeeQuery.rbac.js';

// shift.route.js / holiday.route.js GET list + detail.
export const SHIFTS_ACCESS = Object.freeze({ anyOf: ['students.read'] });
// shift.route.js GET /:shiftId/assignees.
export const SHIFT_ASSIGNEE_PERMISSIONS = Object.freeze(['attendance.assign']);
export const COMPANY_HOLIDAY_PERMISSIONS = Object.freeze(['students.read']);
// Another person's schedule is Employees-page data (shift / week-off / holidays live on the Employee record).
export const OTHER_SCHEDULE_PERMISSIONS = EMPLOYEE_QUERY_READ_PERMISSIONS;

export const MAX_SCHEDULE_LIST = 50;

/** Fail-closed guard: every schedule tool needs the viewer's id (self lookups key on it). */
export function scheduleScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('schedule tools need an authenticated user with an id');
  }
  return ctx.user;
}

export const userIdOf = (user) => String(user.id ?? user._id);

export function hasAnyPermission(user, perms) {
  if (user?.platformSuperUser) return true;
  const set = user?.authContext?.permissions;
  return !!set && perms.some((p) => set.has(p));
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function scheduleDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    Employee: deps.Employee ?? EmployeeModel,
    Student: deps.Student ?? StudentModel,
    queryShifts: deps.queryShifts ?? realQueryShifts,
    queryShiftAssignees: deps.queryShiftAssignees ?? realQueryShiftAssignees,
    queryHolidays: deps.queryHolidays ?? realQueryHolidays,
  };
}

const SCHEDULE_FIELDS = 'fullName employeeId owner user shift weekOff holidays leavesAllowed';
const SHIFT_FIELDS = 'name timezone startTime endTime isActive';
const HOLIDAY_FIELDS = 'title date endDate isActive';

/** One profile (Employee or Student) with its shift and assigned holidays populated. */
export function loadScheduleProfile(Model, filter) {
  return Model.findOne(filter)
    .select(SCHEDULE_FIELDS)
    .populate('shift', SHIFT_FIELDS)
    .populate('holidays', HOLIDAY_FIELDS)
    .lean();
}

export const shapeShift = (s) =>
  s && typeof s === 'object'
    ? { name: s.name ?? null, timezone: s.timezone ?? null, startTime: s.startTime ?? null, endTime: s.endTime ?? null }
    : null;

export const shapeHoliday = (h) => ({ title: h.title ?? null, date: h.date ?? null, endDate: h.endDate ?? null });

/**
 * A profile's ASSIGNED holidays (Employee.holidays / Student.holidays — what attendance.service
 * assigns and the portal shows), active only, inside [from, to] (ISO instants; either optional),
 * soonest first. A multi-day holiday counts while any of it is inside the window.
 */
export function assignedHolidays(profile, { from, to } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  return (profile?.holidays || [])
    .filter((h) => h && typeof h === 'object' && h.isActive !== false && h.date)
    .filter((h) => {
      const start = new Date(h.date).getTime();
      const end = h.endDate ? new Date(h.endDate).getTime() : start;
      return end >= fromMs && start <= toMs;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(shapeHoliday);
}

/** Start of today (UTC) as an ISO instant — the default lower bound for "upcoming". */
export const todayStartIso = (now = new Date()) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
