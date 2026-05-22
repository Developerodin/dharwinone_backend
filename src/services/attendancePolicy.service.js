/**
 * Attendance Policy Engine (P2)
 *
 * Centralizes holiday, leave, and week-off validation that was previously scattered
 * across attendance.service.js.  Both student-based and user-based punch paths call
 * these helpers so the rules stay consistent.
 *
 * Design decisions:
 *  - All date comparisons use UTC-midnight values so they are timezone-independent
 *    in the DB, while timezone-aware local date derivation is done before calling
 *    these helpers.
 *  - Functions return structured decision objects rather than throwing so callers
 *    can choose between warn-only mode (P2 flag) and enforce mode.
 *  - The `resolveAttendanceDay` helper is extracted here to avoid duplication
 *    between punchIn and punchOut paths.
 */

import Student from '../models/student.model.js';
import Attendance from '../models/attendance.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Derive the UTC-midnight "attendance date" and local weekday name for a given instant
 * in a IANA timezone.  Mirrors the private `getLocalMidnightAndDay` in attendance.service.js
 * but is exported for reuse.
 *
 * @param {Date|string|number} instant
 * @param {string} [timezone='UTC']
 * @returns {{ midnight: Date, day: string }}
 */
const resolveAttendanceDay = (instant, timezone = 'UTC') => {
  const tz = timezone && timezone.trim() ? timezone.trim() : 'UTC';
  const d = new Date(instant);
  if (tz === 'UTC') {
    return {
      midnight: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
      day: DAY_NAMES[d.getUTCDay()],
    };
  }
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dateFmt.formatToParts(d);
  const getPart = (name) => parts.find((p) => p.type === name)?.value;
  const y = parseInt(getPart('year'), 10);
  const m = parseInt(getPart('month'), 10) - 1;
  const dd = parseInt(getPart('day'), 10);
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const day = weekdayFmt.format(d);
  const midnight = new Date(Date.UTC(y, m, dd));
  return { midnight, day };
};

/**
 * Build a Set of UTC-midnight timestamps covered by a holiday record.
 * @param {{ date: Date, endDate?: Date | null }} holiday
 * @returns {Set<number>}
 */
const holidayToTimestamps = (holiday) => {
  const start = new Date(holiday.date);
  start.setUTCHours(0, 0, 0, 0);
  const end = holiday.endDate ? new Date(holiday.endDate) : start;
  end.setUTCHours(0, 0, 0, 0);
  const set = new Set();
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += oneDayMs) {
    set.add(t);
  }
  return set;
};

/**
 * Check whether a UTC-midnight date falls on any of the student's assigned holidays.
 *
 * @param {import('../models/student.model.js').default} student - populated with `holidays` array
 * @param {Date} localMidnight - UTC-midnight for the attendance day
 * @returns {{ blocked: boolean, reason?: string, holidayTitle?: string }}
 */
const isHoliday = (student, localMidnight) => {
  const ts = localMidnight.getTime();
  for (const h of student.holidays || []) {
    const holidayDoc = typeof h === 'object' && h !== null && h.date ? h : null;
    if (!holidayDoc) continue;
    if (!holidayDoc.isActive) continue;
    const set = holidayToTimestamps(holidayDoc);
    if (set.has(ts)) {
      return { blocked: true, reason: 'HOLIDAY_BLOCKED', holidayTitle: holidayDoc.title };
    }
  }
  return { blocked: false };
};

/**
 * Check whether a UTC-midnight date is the student's week-off day.
 *
 * @param {import('../models/student.model.js').default} student
 * @param {string} dayName  - Local weekday name ('Monday', 'Tuesday', …)
 * @returns {{ blocked: boolean, reason?: string }}
 */
const isWeekOff = (student, dayName) => {
  const weekOff = Array.isArray(student.weekOff) ? student.weekOff : [];
  if (weekOff.length && weekOff.includes(dayName)) {
    return { blocked: true, reason: 'WEEK_OFF_BLOCKED' };
  }
  return { blocked: false };
};

/**
 * Check whether there is an existing Leave attendance row on the given date.
 *
 * @param {string|import('mongoose').Types.ObjectId} studentId
 * @param {Date} localMidnight
 * @returns {Promise<{ blocked: boolean, reason?: string }>}
 */
const isLeave = async (studentId, localMidnight) => {
  const existing = await Attendance.findOne({
    student: studentId,
    date: localMidnight,
    status: 'Leave',
  }).lean();
  if (existing) {
    return { blocked: true, reason: 'LEAVE_BLOCKED' };
  }
  return { blocked: false };
};

/**
 * Validate whether a student is permitted to punch in at the given time.
 * Returns a structured decision object; callers decide whether to throw or warn.
 *
 * @param {string|import('mongoose').Types.ObjectId} studentId
 * @param {Date} punchInTime
 * @param {string} [timezone='UTC']
 * @returns {Promise<{ allowed: boolean, reason?: string, detail?: string }>}
 */
const validatePunchIn = async (studentId, punchInTime, timezone = 'UTC') => {
  const student = await Student.findById(studentId)
    .populate('holidays')
    .populate('shift', 'timezone')
    .lean();
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const effectiveTz = student.shift?.timezone || timezone;
  const { midnight, day } = resolveAttendanceDay(punchInTime, effectiveTz);

  const holidayCheck = isHoliday(student, midnight);
  if (holidayCheck.blocked) {
    return {
      allowed: false,
      reason: holidayCheck.reason,
      detail: holidayCheck.holidayTitle
        ? `Punch in blocked: '${holidayCheck.holidayTitle}' is an assigned holiday.`
        : 'Punch in blocked: assigned holiday.',
    };
  }

  const weekOffCheck = isWeekOff(student, day);
  if (weekOffCheck.blocked) {
    return {
      allowed: false,
      reason: weekOffCheck.reason,
      detail: `Punch in blocked: ${day} is a week-off day.`,
    };
  }

  const leaveCheck = await isLeave(studentId, midnight);
  if (leaveCheck.blocked) {
    return {
      allowed: false,
      reason: leaveCheck.reason,
      detail: 'Punch in blocked: leave is recorded for this day.',
    };
  }

  if (student.joiningDate) {
    const joining = new Date(student.joiningDate);
    joining.setUTCHours(0, 0, 0, 0);
    if (midnight < joining) {
      return {
        allowed: false,
        reason: 'BEFORE_JOINING_DATE',
        detail: `Punch in blocked: before joining date (${joining.toISOString().split('T')[0]}).`,
      };
    }
  }

  return { allowed: true };
};

/**
 * Validate whether a student can punch out (has an active session, session not on holiday/leave).
 * Primarily guards against punching out on a row that was flipped to Holiday/Leave after punch-in.
 *
 * @param {string|import('mongoose').Types.ObjectId} studentId
 * @param {Date} punchOutTime
 * @param {string} [timezone='UTC']
 * @returns {Promise<{ allowed: boolean, reason?: string, detail?: string, activeRecord?: object }>}
 */
const validatePunchOut = async (studentId, punchOutTime, timezone = 'UTC') => {
  const student = await Student.findById(studentId)
    .populate('shift', 'timezone')
    .lean();
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const effectiveTz = student.shift?.timezone || timezone;
  const { midnight: today } = resolveAttendanceDay(new Date(), effectiveTz);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const active = await Attendance.findOne({
    student: studentId,
    date: { $in: [tomorrow, today, yesterday, dayBefore] },
    punchOut: null,
    isActive: true,
    status: { $nin: ['Holiday', 'Leave'] },
  })
    .sort({ punchIn: -1 })
    .lean();

  if (!active) {
    return { allowed: false, reason: 'NO_ACTIVE_PUNCH', detail: 'No active punch-in found to punch out.' };
  }

  if (punchOutTime <= new Date(active.punchIn)) {
    return { allowed: false, reason: 'INVALID_TIME_ORDER', detail: 'Punch out time must be after punch in time.' };
  }

  return { allowed: true, activeRecord: active };
};

export { resolveAttendanceDay, isHoliday, isWeekOff, isLeave, validatePunchIn, validatePunchOut };
export default { resolveAttendanceDay, isHoliday, isWeekOff, isLeave, validatePunchIn, validatePunchOut };
