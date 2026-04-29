import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Attendance from '../models/attendance.model.js';
import Student from '../models/student.model.js';
import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import Holiday from '../models/holiday.model.js';
import { hasExceededDurationInTimezone } from '../utils/timezone.js';
import {
  aggregateDailyCappedWorkMs,
  computeDurationMs,
  effectiveSessionDurationMs,
  getMaxSessionDurationMs,
} from '../utils/attendanceDuration.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Get UTC midnight for a given date (used as attendance "date" for calendar-date inputs). */
const getUtcMidnight = (d) => {
  const date = new Date(d);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const getDayName = (date) => DAY_NAMES[date.getUTCDay()];

/**
 * Timezone-aware date/day derivation. Returns { midnight, day } where:
 * - midnight = Date(UTC(localY, localM, localD)) — a "date-only" convention
 * - day = local weekday name ("Monday", "Tuesday", etc.)
 * Uses Intl.DateTimeFormat to extract the local calendar date in the given IANA timezone
 * (same technique used in getShiftWindowUtc in attendanceDuration.js).
 */
const getLocalMidnightAndDay = (instant, timezone) => {
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
 * Lower bound for listing/statistics: never include days before the student's joining date.
 * The UI sends startDate as the first day of the visible month, which would otherwise
 * override joiningDate and show pre-join punches (e.g. joining 05-Jan-26 but calendar Dec-25).
 * @param {string|Date|undefined|null} requestedStart - query startDate
 * @param {Date|null|undefined} joiningDate - Student.joiningDate
 * @returns {Date|null}
 */
const effectiveListStartDate = (requestedStart, joiningDate) => {
  const req =
    requestedStart !== undefined && requestedStart !== null && requestedStart !== ''
      ? getUtcMidnight(requestedStart)
      : null;
  const join = joiningDate ? getUtcMidnight(joiningDate) : null;
  if (req && join) {
    return req.getTime() >= join.getTime() ? req : join;
  }
  return req || join;
};

/**
 * Get all UTC-midnight dates for a holiday (single day or range [date, endDate] inclusive).
 * @param {{ date: Date, endDate?: Date | null }} holiday
 * @returns {Date[]}
 */
const getHolidayDates = (holiday) => {
  const start = new Date(holiday.date);
  start.setUTCHours(0, 0, 0, 0);
  const end = holiday.endDate ? new Date(holiday.endDate) : start;
  end.setUTCHours(0, 0, 0, 0);
  if (end.getTime() < start.getTime()) return [start];
  const dates = [];
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += oneDayMs) {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    dates.push(d);
  }
  return dates;
};

/**
 * Punch in for a student.
 * @param {string} studentId
 * @param {Object} body - { punchInTime?, notes?, timezone? }
 */
const punchIn = async (studentId, body = {}) => {
  const student = await Student.findById(studentId).populate('user', 'name email').populate('shift', 'timezone');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const punchInTime = body.punchInTime ? new Date(body.punchInTime) : new Date();
  const timezone = body.timezone && body.timezone.trim() ? body.timezone.trim() : 'UTC';
  const notes = body.notes != null ? String(body.notes) : '';

  const effectiveTz = student.shift?.timezone || timezone;
  const { midnight: attendanceDate, day } = getLocalMidnightAndDay(punchInTime, effectiveTz);

  // Attendance starts from joining date (if set)
  if (student.joiningDate) {
    const joiningMidnight = getUtcMidnight(student.joiningDate);
    if (attendanceDate < joiningMidnight) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attendance cannot be recorded before joining date (${joiningMidnight.toISOString().split('T')[0]})`
      );
    }
  }

  // Only reuse a record that is still active (no punch-out yet). Every completed session
  // stays as its own entry; a new punch-in on the same day creates a new record.
  const existing = await Attendance.findOne({
    student: studentId,
    date: attendanceDate,
    isActive: true,
    punchOut: null,
  }).sort({ punchIn: -1 });

  if (existing) {
    if (existing.status === 'Holiday' || existing.status === 'Leave') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot punch in on Holiday or Leave day', true, '', 'HOLIDAY_BLOCKED');
    }
    existing.punchIn = punchInTime;
    existing.timezone = timezone;
    if (notes) existing.notes = notes;
    existing.status = 'Absent';
    if (!existing.studentName && student.user?.name) existing.studentName = student.user.name;
    if (!existing.studentEmail && (student.user?.email ?? student.email)) existing.studentEmail = student.user?.email ?? student.email;
    await existing.save();
    return existing;
  }

  const attendance = await Attendance.create({
    student: studentId,
    studentEmail: student.user?.email ?? student.email ?? '',
    studentName: student.user?.name ?? '',
    date: attendanceDate,
    day,
    punchIn: punchInTime,
    punchOut: null,
    timezone,
    notes,
    status: 'Absent',
    isActive: true,
  });
  return attendance;
};

/**
 * Punch out for a student. Finds active punch in today, yesterday, or day-before-yesterday.
 */
const punchOut = async (studentId, body = {}) => {
  const student = await Student.findById(studentId).populate('user', 'email').populate('shift', 'name timezone startTime endTime');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const punchOutTime = body.punchOutTime ? new Date(body.punchOutTime) : new Date();
  const notes = body.notes != null ? String(body.notes) : '';

  const now = new Date();
  const effectiveTz = student.shift?.timezone || 'UTC';
  const { midnight: today } = getLocalMidnightAndDay(now, effectiveTz);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);

  const active = await Attendance.findOne({
    student: studentId,
    date: { $in: [tomorrow, today, yesterday, dayBefore] },
    punchOut: null,
    isActive: true,
    status: { $nin: ['Holiday', 'Leave'] },
  }).sort({ punchIn: -1 });

  if (!active) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No active punch-in found to punch out', true, '', 'NO_ACTIVE_PUNCH');
  }
  if (punchOutTime <= active.punchIn) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Punch out time must be after punch in time');
  }

  active.punchOut = punchOutTime;
  if (notes) active.notes = notes;
  active.status = 'Present';
  const shift = student.shift && (student.shift.startTime || student.shift.timezone) ? student.shift : null;
  active.duration = computeDurationMs(active.punchIn, punchOutTime, shift);
  await active.save();
  return active;
};

/**
 * Get current punch status for a student (active record if any).
 */
const getCurrentPunchStatus = async (studentId) => {
  const student = await Student.findById(studentId).populate('shift', 'name timezone startTime endTime');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const shiftMeta =
    student.shift?.startTime && student.shift?.endTime && student.shift?.timezone
      ? {
          startTime: student.shift.startTime,
          endTime: student.shift.endTime,
          timezone: student.shift.timezone,
          name: student.shift.name || undefined,
        }
      : null;

  const now = new Date();
  const effectiveTz = student.shift?.timezone || 'UTC';
  const { midnight: today } = getLocalMidnightAndDay(now, effectiveTz);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);

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
    return {
      isPunchedIn: false,
      record: null,
      elapsedPreview: null,
      shift: shiftMeta,
    };
  }

  const punchIn = new Date(active.punchIn);
  const sessionMs = Math.max(0, now.getTime() - punchIn.getTime());
  const eligibleMs = computeDurationMs(punchIn, now, shiftMeta);

  return {
    isPunchedIn: true,
    record: {
      id: active._id?.toString?.(),
      punchIn: active.punchIn,
      timezone: active.timezone,
      date: active.date,
    },
    elapsedPreview: { sessionMs, eligibleMs },
    shift: shiftMeta,
  };
};

/**
 * List attendance records for a student with optional date range.
 */
const listByStudent = async (studentId, query = {}) => {
  const student = await Student.findById(studentId).select('joiningDate');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const { startDate, endDate, limit = 100, page = 1 } = query;
  const filter = { student: studentId, isActive: true };

  filter.date = {};
  const effectiveStart = effectiveListStartDate(startDate, student.joiningDate);
  if (effectiveStart) filter.date.$gte = effectiveStart;
  filter.date.$lte = endDate ? getUtcMidnight(endDate) : getUtcMidnight(new Date());

  if (Object.keys(filter.date).length === 0) delete filter.date;

  const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(500, Math.max(1, parseInt(limit, 10)));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));

  const [rawResults, total] = await Promise.all([
    Attendance.find(filter).sort({ date: -1, punchIn: -1 }).skip(skip).limit(limitNum).lean(),
    Attendance.countDocuments(filter),
  ]);

  const maxMs = getMaxSessionDurationMs();
  const results = rawResults.map((r) => {
    const duration = effectiveSessionDurationMs(r);
    if (
      r.punchOut &&
      duration != null &&
      r.duration !== duration &&
      (r.duration == null || r.duration === 0 || r.duration > maxMs)
    ) {
      Attendance.updateOne({ _id: r._id }, { $set: { duration } }, { background: true }).catch(() => {});
    }
    return {
      ...r,
      duration: duration != null ? duration : r.duration,
      id: r._id?.toString?.() ?? r.id,
    };
  });

  return {
    results,
    page: parseInt(page, 10),
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum),
    totalResults: total,
  };
};

/** Default "work day" bounds for late/early (hours in 0-24, in record timezone). */
const DEFAULT_WORK_START_HOUR = 9;
const DEFAULT_WORK_END_HOUR = 17;

/**
 * Get local hour (0-24) of a date in a given IANA timezone.
 */
const getLocalHourInTz = (date, timezone) => {
  try {
    const str = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', hour: 'numeric', hour12: false }).format(new Date(date));
    return parseInt(str, 10);
  } catch {
    return new Date(date).getUTCHours();
  }
};

/**
 * Basic statistics for a student (total days, total hours, summary report).
 * Includes totalHoursWeek, totalHoursMonth, averageSessionMinutes, latePunchInCount, earlyPunchOutCount.
 */
const getStatistics = async (studentId, query = {}) => {
  const student = await Student.findById(studentId).select('joiningDate');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const { startDate, endDate } = query;
  const filter = { student: studentId, isActive: true, punchOut: { $ne: null } };
  if (startDate || endDate || student.joiningDate) {
    filter.date = {};
    const effectiveStart = effectiveListStartDate(startDate, student.joiningDate);
    if (effectiveStart) filter.date.$gte = effectiveStart;
    if (endDate) filter.date.$lte = getUtcMidnight(endDate);
  }

  const records = await Attendance.find(filter).select('duration punchIn punchOut timezone date status').lean();
  const msFor = (r) => effectiveSessionDurationMs(r) || 0;
  const totalMs = aggregateDailyCappedWorkMs(records, msFor);
  const totalHours = Math.round((totalMs / (1000 * 60 * 60)) * 100) / 100;

  const now = new Date();
  const weekStart = getUtcMidnight(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const monthStart = getUtcMidnight(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const weekMs = aggregateDailyCappedWorkMs(
    records.filter((r) => r.date >= weekStart),
    msFor
  );
  const monthMs = aggregateDailyCappedWorkMs(
    records.filter((r) => r.date >= monthStart),
    msFor
  );
  const totalHoursWeek = Math.round((weekMs / (1000 * 60 * 60)) * 100) / 100;
  const totalHoursMonth = Math.round((monthMs / (1000 * 60 * 60)) * 100) / 100;

  const workSessions = records.filter((r) => r.status !== 'Holiday' && r.status !== 'Leave');
  const sessionsWithDuration = workSessions.filter((r) => msFor(r) > 0);
  const averageSessionMinutes = sessionsWithDuration.length
    ? Math.round(sessionsWithDuration.reduce((s, r) => s + msFor(r), 0) / sessionsWithDuration.length / 60000)
    : null;

  const workStartHour = Number(process.env.ATTENDANCE_WORK_START_HOUR) || DEFAULT_WORK_START_HOUR;
  const workEndHour = Number(process.env.ATTENDANCE_WORK_END_HOUR) || DEFAULT_WORK_END_HOUR;
  let latePunchInCount = 0;
  let earlyPunchOutCount = 0;
  for (const r of records) {
    const tz = r.timezone || 'UTC';
    if (r.punchIn) {
      const hour = getLocalHourInTz(r.punchIn, tz);
      if (hour > workStartHour) latePunchInCount += 1;
    }
    if (r.punchOut) {
      const hour = getLocalHourInTz(r.punchOut, tz);
      if (hour < workEndHour) earlyPunchOutCount += 1;
    }
  }

  return {
    totalDays: records.length,
    totalHours,
    totalMinutes: Math.round(totalMs / (1000 * 60)),
    totalHoursWeek,
    totalHoursMonth,
    averageSessionMinutes,
    latePunchInCount,
    earlyPunchOutCount,
  };
};

/**
 * Punch in for a user (agent; no Student). Creates Attendance with user set, student null.
 * @param {string} userId
 * @param {Object} body - { punchInTime?, notes?, timezone? }
 */
const punchInByUser = async (userId, body = {}) => {
  const user = await User.findById(userId).select('name email').lean();
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const punchInTime = body.punchInTime ? new Date(body.punchInTime) : new Date();
  const timezone = body.timezone && body.timezone.trim() ? body.timezone.trim() : 'UTC';
  const notes = body.notes != null ? String(body.notes) : '';

  const { midnight: attendanceDate, day } = getLocalMidnightAndDay(punchInTime, timezone);

  const existing = await Attendance.findOne({
    user: userId,
    date: attendanceDate,
    isActive: true,
    punchOut: null,
  })
    .sort({ punchIn: -1 })
    .lean();

  if (existing) {
    if (existing.status === 'Holiday' || existing.status === 'Leave') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot punch in on Holiday or Leave day', true, '', 'HOLIDAY_BLOCKED');
    }
    const doc = await Attendance.findById(existing._id);
    doc.punchIn = punchInTime;
    doc.timezone = timezone;
    if (notes) doc.notes = notes;
    doc.status = 'Absent';
    doc.studentEmail = doc.studentEmail || user.email || '';
    doc.studentName = doc.studentName || user.name || '';
    await doc.save();
    return doc;
  }

  const attendance = await Attendance.create({
    user: userId,
    studentEmail: user.email || '',
    studentName: user.name || '',
    date: attendanceDate,
    day,
    punchIn: punchInTime,
    punchOut: null,
    timezone,
    notes,
    status: 'Absent',
    isActive: true,
  });
  return attendance;
};

/**
 * Punch out for a user (agent). Finds active punch in by user.
 */
const punchOutByUser = async (userId, body = {}) => {
  const user = await User.findById(userId).select('email').lean();
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const punchOutTime = body.punchOutTime ? new Date(body.punchOutTime) : new Date();
  const notes = body.notes != null ? String(body.notes) : '';

  const now = new Date();
  const today = getUtcMidnight(now);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);

  const active = await Attendance.findOne({
    user: userId,
    date: { $in: [tomorrow, today, yesterday, dayBefore] },
    punchOut: null,
    isActive: true,
    status: { $nin: ['Holiday', 'Leave'] },
  }).sort({ punchIn: -1 });

  if (!active) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No active punch-in found to punch out', true, '', 'NO_ACTIVE_PUNCH');
  }
  if (punchOutTime <= active.punchIn) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Punch out time must be after punch in time');
  }

  active.punchOut = punchOutTime;
  if (notes) active.notes = notes;
  active.status = 'Present';
  // Same helper as student punch-out; User has no shift today → null → raw ms.
  active.duration = computeDurationMs(active.punchIn, punchOutTime, null);
  await active.save();
  return active;
};

/**
 * Get current punch status for a user (agent). Active record if any.
 */
const getCurrentPunchStatusByUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const now = new Date();
  const today = getUtcMidnight(now);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);

  const active = await Attendance.findOne({
    user: userId,
    date: { $in: [tomorrow, today, yesterday, dayBefore] },
    punchOut: null,
    isActive: true,
    status: { $nin: ['Holiday', 'Leave'] },
  })
    .sort({ punchIn: -1 })
    .lean();

  if (!active) {
    return { isPunchedIn: false, record: null, elapsedPreview: null, shift: null };
  }

  const punchIn = new Date(active.punchIn);
  const sessionMs = Math.max(0, now.getTime() - punchIn.getTime());

  return {
    isPunchedIn: true,
    record: {
      id: active._id?.toString?.(),
      punchIn: active.punchIn,
      timezone: active.timezone,
      date: active.date,
    },
    elapsedPreview: { sessionMs, eligibleMs: sessionMs },
    shift: null,
  };
};

/**
 * List attendance records for a user (agent). No joining-date filter.
 */
const listByUser = async (userId, query = {}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const { startDate, endDate, limit = 100, page = 1 } = query;
  const filter = { user: userId, isActive: true };

  filter.date = {};
  if (startDate) filter.date.$gte = getUtcMidnight(startDate);
  filter.date.$lte = endDate ? getUtcMidnight(endDate) : getUtcMidnight(new Date());

  const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(500, Math.max(1, parseInt(limit, 10)));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));

  const [rawResults, total] = await Promise.all([
    Attendance.find(filter).sort({ date: -1, punchIn: -1 }).skip(skip).limit(limitNum).lean(),
    Attendance.countDocuments(filter),
  ]);

  const maxMs = getMaxSessionDurationMs();
  const results = rawResults.map((r) => {
    const duration = effectiveSessionDurationMs(r);
    if (
      r.punchOut &&
      duration != null &&
      r.duration !== duration &&
      (r.duration == null || r.duration === 0 || r.duration > maxMs)
    ) {
      Attendance.updateOne({ _id: r._id }, { $set: { duration } }, { background: true }).catch(() => {});
    }
    return {
      ...r,
      student: r.user,
      duration: duration != null ? duration : r.duration,
      id: r._id?.toString?.() ?? r.id,
    };
  });

  return {
    results,
    page: parseInt(page, 10),
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum),
    totalResults: total,
  };
};

/**
 * Get statistics for a user (agent). Same shape as getStatistics.
 */
const getStatisticsByUser = async (userId, query = {}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const { startDate, endDate } = query;
  const filter = { user: userId, isActive: true, punchOut: { $ne: null } };
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = getUtcMidnight(startDate);
    if (endDate) filter.date.$lte = getUtcMidnight(endDate);
  }

  const records = await Attendance.find(filter).select('duration punchIn punchOut timezone date status').lean();
  const msFor = (r) => effectiveSessionDurationMs(r) || 0;
  const totalMs = aggregateDailyCappedWorkMs(records, msFor);
  const totalHours = Math.round((totalMs / (1000 * 60 * 60)) * 100) / 100;

  const now = new Date();
  const weekStart = getUtcMidnight(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const monthStart = getUtcMidnight(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const weekMs = aggregateDailyCappedWorkMs(
    records.filter((r) => r.date >= weekStart),
    msFor
  );
  const monthMs = aggregateDailyCappedWorkMs(
    records.filter((r) => r.date >= monthStart),
    msFor
  );
  const totalHoursWeek = Math.round((weekMs / (1000 * 60 * 60)) * 100) / 100;
  const totalHoursMonth = Math.round((monthMs / (1000 * 60 * 60)) * 100) / 100;

  const workSessions = records.filter((r) => r.status !== 'Holiday' && r.status !== 'Leave');
  const sessionsWithDuration = workSessions.filter((r) => msFor(r) > 0);
  const averageSessionMinutes = sessionsWithDuration.length
    ? Math.round(sessionsWithDuration.reduce((s, r) => s + msFor(r), 0) / sessionsWithDuration.length / 60000)
    : null;

  const workStartHour = Number(process.env.ATTENDANCE_WORK_START_HOUR) || DEFAULT_WORK_START_HOUR;
  const workEndHour = Number(process.env.ATTENDANCE_WORK_END_HOUR) || DEFAULT_WORK_END_HOUR;
  let latePunchInCount = 0;
  let earlyPunchOutCount = 0;
  for (const r of records) {
    const tz = r.timezone || 'UTC';
    if (r.punchIn) {
      const hour = getLocalHourInTz(r.punchIn, tz);
      if (hour > workStartHour) latePunchInCount += 1;
    }
    if (r.punchOut) {
      const hour = getLocalHourInTz(r.punchOut, tz);
      if (hour < workEndHour) earlyPunchOutCount += 1;
    }
  }

  return {
    totalDays: records.length,
    totalHours,
    totalMinutes: Math.round(totalMs / (1000 * 60)),
    totalHoursWeek,
    totalHoursMonth,
    averageSessionMinutes,
    latePunchInCount,
    earlyPunchOutCount,
  };
};

/**
 * Get track list: all students with their current/latest punch status (punch in, punch out, timezone).
 * For use on admin "Track Attendance" page. Requires students to be listed separately (caller has students.read).
 * @param {Object} options - { search?: string } - optional filter by name, email, employeeId
 */
const getTrackList = async (options = {}) => {
  const latestPerStudent = await Attendance.aggregate([
    { $match: { isActive: true, status: { $nin: ['Holiday', 'Leave'] }, student: { $ne: null } } },
    { $sort: { student: 1, punchIn: -1 } },
    {
      $group: {
        _id: '$student',
        punchIn: { $first: '$punchIn' },
        punchOut: { $first: '$punchOut' },
        timezone: { $first: '$timezone' },
        duration: { $first: '$duration' },
        studentEmail: { $first: '$studentEmail' },
        studentName: { $first: '$studentName' },
        hasOpen: { $max: { $cond: [{ $eq: ['$punchOut', null] }, 1, 0] } },
      },
    },
  ]);
  const studentIds = latestPerStudent.map((s) => s._id).filter(Boolean);
  const students = await Student.find({ _id: { $in: studentIds } })
    .populate('user', 'name email')
    .lean();
  const byStudent = new Map(students.map((s) => [s._id.toString(), s]));

  // Fetch Candidate by owner (User) to get employeeId for each student
  const userIds = students.map((s) => s.user?._id).filter(Boolean);
  const candidates = userIds.length > 0
    ? await Employee.find({ owner: { $in: userIds } }).select('owner employeeId').lean()
    : [];
  const ownerToEmployeeId = new Map(candidates.map((c) => [c.owner?.toString?.(), c.employeeId || '']));

  // For deleted students, try to find User by stored email
  const orphanEmails = latestPerStudent
    .filter((row) => !byStudent.has(row._id?.toString?.()) && row.studentEmail)
    .map((row) => row.studentEmail);
  const usersByEmail = orphanEmails.length > 0
    ? await User.find({ email: { $in: orphanEmails } }).select('name email').lean()
    : [];
  const emailToUser = new Map(usersByEmail.map((u) => [u.email, u]));

  let results = latestPerStudent.map((row) => {
    const student = byStudent.get(row._id?.toString?.());
    const user = student?.user;
    const fallbackUser = !user && row.studentEmail ? emailToUser.get(row.studentEmail) : null;
    const durationMs = effectiveSessionDurationMs({
      punchIn: row.punchIn,
      punchOut: row.punchOut,
      duration: row.duration,
    });
    const email = user?.email ?? fallbackUser?.email ?? row.studentEmail ?? '—';
    const studentName = user?.name ?? fallbackUser?.name ?? row.studentName ?? '—';
    const employeeId = user?._id ? (ownerToEmployeeId.get(user._id?.toString?.()) || '') : '';
    return {
      studentId: row._id?.toString?.(),
      studentName,
      email,
      employeeId: employeeId || undefined,
      isPunchedIn: row.hasOpen === 1,
      punchIn: row.punchIn != null ? row.punchIn : null,
      punchOut: row.punchOut != null ? row.punchOut : null,
      timezone: row.timezone || 'UTC',
      durationMs: durationMs != null ? durationMs : null,
    };
  });
  const noAttendanceStudents = await Student.find({ _id: { $nin: studentIds } })
    .populate('user', 'name email')
    .lean();
  const noAttendanceUserIds = noAttendanceStudents.map((s) => s.user?._id).filter(Boolean);
  const noAttendanceCandidates =
    noAttendanceUserIds.length > 0
      ? await Employee.find({ owner: { $in: noAttendanceUserIds } }).select('owner employeeId').lean()
      : [];
  const noAttendanceOwnerToEmployeeId = new Map(noAttendanceCandidates.map((c) => [c.owner?.toString?.(), c.employeeId || '']));

  noAttendanceStudents.forEach((s) => {
    const studentName = s?.user?.name ?? '—';
    const email = s?.user?.email ?? '—';
    const employeeId = s?.user?._id ? (noAttendanceOwnerToEmployeeId.get(s.user._id?.toString?.()) || '') : '';
    results.push({
      studentId: s._id?.toString?.(),
      studentName,
      email,
      employeeId: employeeId || undefined,
      isPunchedIn: false,
      punchIn: null,
      punchOut: null,
      timezone: 'UTC',
      durationMs: null,
    });
  });

  const { search } = options;
  if (search && typeof search === 'string' && search.trim()) {
    const term = search.trim().toLowerCase();
    results = results.filter((r) => {
      const name = (r.studentName || '').toLowerCase();
      const em = (r.email || '').toLowerCase();
      const empId = (r.employeeId || '').toLowerCase();
      return name.includes(term) || em.includes(term) || empId.includes(term);
    });
  }

  return { results };
};

/** Escape special regex chars in a string for safe $regex use */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Get full attendance history: one row per completed attendance record (student has punched out).
 * Only shows records after the student has timed out; in-progress sessions are excluded.
 * Uses aggregation to preserve studentId even when Student is deleted, and resolve name/email from
 * User, or fall back to stored studentName/studentEmail on the record.
 * @param {Object} options - { startDate?, endDate?, limit?, search? }
 */
const getTrackHistory = async (options = {}) => {
  const { startDate, endDate, limit = 500, search } = options;
  const match = { isActive: true, punchOut: { $ne: null }, status: { $nin: ['Holiday', 'Leave'] }, student: { $ne: null } };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = getUtcMidnight(startDate);
    if (endDate) match.date.$lte = getUtcMidnight(endDate);
  }
  const limitNum = Math.min(1000, Math.max(1, Number(limit) || 500));
  const studentsColl = Student.collection?.name || 'students';
  const usersColl = User.collection?.name || 'users';
  const candidatesColl = Employee.collection?.name || 'candidates';

  const pipeline = [
    { $match: match },
    { $sort: { date: -1, punchIn: -1 } },
    { $limit: limitNum },
    // Primary path: Attendance → Student → User
    { $lookup: { from: studentsColl, localField: 'student', foreignField: '_id', as: 'studentDoc' } },
    { $unwind: { path: '$studentDoc', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: usersColl, localField: 'studentDoc.user', foreignField: '_id', as: 'userDoc' } },
    { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
    // Fallback path: look up User by stored studentEmail (for deleted students)
    { $lookup: { from: usersColl, localField: 'studentEmail', foreignField: 'email', as: 'userByEmail' } },
    { $unwind: { path: '$userByEmail', preserveNullAndEmptyArrays: true } },
    // Candidate lookup for employeeId (preserveNullAndEmptyArrays - many students have no Candidate)
    { $lookup: { from: candidatesColl, localField: 'studentDoc.user', foreignField: 'owner', as: 'candidateDoc' } },
    { $unwind: { path: '$candidateDoc', preserveNullAndEmptyArrays: true } },
  ];

  const searchTerm = search && typeof search === 'string' ? search.trim() : '';
  if (searchTerm) {
    const regex = { $regex: escapeRegex(searchTerm), $options: 'i' };
    pipeline.push({
      $match: {
        $or: [
          { 'userDoc.name': regex },
          { 'userDoc.email': regex },
          { studentName: regex },
          { studentEmail: regex },
          { 'candidateDoc.employeeId': regex },
        ],
      },
    });
  }

  pipeline.push({
    $project: {
        id: { $toString: '$_id' },
        studentId: { $ifNull: [{ $toString: '$student' }, ''] },
        studentExists: { $ne: ['$studentDoc', null] },
        studentName: {
          $switch: {
            branches: [
              { case: { $and: [{ $ne: ['$userDoc.name', null] }, { $ne: ['$userDoc.name', ''] }] }, then: '$userDoc.name' },
              { case: { $and: [{ $ne: ['$userByEmail.name', null] }, { $ne: ['$userByEmail.name', ''] }] }, then: '$userByEmail.name' },
              { case: { $and: [{ $ne: ['$studentName', null] }, { $ne: ['$studentName', ''] }] }, then: '$studentName' },
            ],
            default: '—',
          },
        },
        email: {
          $switch: {
            branches: [
              { case: { $and: [{ $ne: ['$userDoc.email', null] }, { $ne: ['$userDoc.email', ''] }] }, then: '$userDoc.email' },
              { case: { $and: [{ $ne: ['$userByEmail.email', null] }, { $ne: ['$userByEmail.email', ''] }] }, then: '$userByEmail.email' },
              { case: { $and: [{ $ne: ['$studentEmail', null] }, { $ne: ['$studentEmail', ''] }] }, then: '$studentEmail' },
            ],
            default: '—',
          },
        },
        employeeId: { $ifNull: ['$candidateDoc.employeeId', ''] },
        date: 1,
        day: 1,
        punchIn: 1,
        punchOut: 1,
        duration: 1,
        timezone: { $ifNull: ['$timezone', 'UTC'] },
    }
  });
  const records = await Attendance.aggregate(pipeline);
  const results = records.map((r) => {
    const durationMs = effectiveSessionDurationMs({
      punchIn: r.punchIn,
      punchOut: r.punchOut,
      duration: r.duration,
    });
    return {
      id: r.id,
      studentId: r.studentId || null,
      studentExists: !!r.studentExists,
      studentName: r.studentName || '—',
      email: r.email || '—',
      employeeId: r.employeeId || undefined,
      date: r.date,
      day: r.day,
      punchIn: r.punchIn,
      punchOut: r.punchOut,
      durationMs,
      timezone: r.timezone || 'UTC',
    };
  });
  return { results };
};

/**
 * Find all active punch-ins (for scheduler). Excludes Holiday/Leave.
 */
const findAllActivePunchIns = async () => {
  return Attendance.find({
    punchOut: null,
    isActive: true,
    status: { $in: ['Present', 'Absent'] },
  })
    .populate('student', 'user')
    .lean();
};

/**
 * Auto punch-out a single record after exceeding duration.
 */
const autoPunchOut = async (record, durationHours) => {
  const exceeded = hasExceededDurationInTimezone(record.punchIn, record.timezone || 'UTC', durationHours);
  if (!exceeded) return null;

  const doc = await Attendance.findById(record._id);
  if (!doc || doc.punchOut != null) return null;

  const now = new Date();
  doc.punchOut = now;
  doc.notes = (doc.notes ? doc.notes + '\n' : '') + `[Auto-punched out after ${durationHours} hours in ${doc.timezone || 'UTC'} timezone]`;
  doc.status = 'Present';
  const student = await Student.findById(doc.student).populate('shift', 'name timezone startTime endTime').lean();
  const shift = student?.shift && (student.shift.startTime || student.shift.timezone) ? student.shift : null;
  doc.duration = computeDurationMs(doc.punchIn, now, shift);
  await doc.save();
  return doc;
};

/**
 * Add holidays to students (assign holiday IDs to students and create Holiday attendance records).
 * Persists: (1) student.holidays array on Student document, (2) Attendance records with status 'Holiday'
 * for each holiday date so they show in the student calendar and list.
 * Uses bulk DB operations so it scales to hundreds/thousands of students.
 *
 * @param {Array<string>} studentIds
 * @param {Array<string>} holidayIds
 * @param {Object} user
 */
const addHolidaysToStudents = async (studentIds, holidayIds, _user) => {
  const students = await Student.find({ _id: { $in: studentIds } })
    .select('joiningDate')
    .populate('user', 'name email')
    .lean();
  if (students.length !== studentIds.length) {
    const foundIds = students.map((s) => String(s._id));
    const missingIds = studentIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some students not found: ${missingIds.join(', ')}`);
  }

  const holidays = await Holiday.find({ _id: { $in: holidayIds }, isActive: true }).lean();
  if (holidays.length !== holidayIds.length) {
    const foundIds = holidays.map((h) => String(h._id));
    const missingIds = holidayIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some holidays not found or inactive: ${missingIds.join(', ')}`);
  }

  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  // 1. Bulk update: add holiday IDs to all students in one op
  await Student.updateMany({ _id: { $in: studentIds } }, { $addToSet: { holidays: { $each: holidayIds } } });

  // 2. Build normalized holiday dates (single day or range [date, endDate] per holiday) and find existing in one query
  const holidayInfos = [];
  for (const h of holidays) {
    const dates = getHolidayDates(h);
    for (const d of dates) {
      holidayInfos.push({ holidayId: h._id, title: h.title, normalizedDate: d });
    }
  }
  const normalizedDates = holidayInfos.map((hi) => hi.normalizedDate);

  const existingAttendances = await Attendance.find({
    student: { $in: studentIds },
    date: { $in: normalizedDates },
    status: 'Holiday',
  })
    .select('student date')
    .lean();

  const existingKeySet = new Set(
    existingAttendances.map((r) => `${String(r.student)}|${new Date(r.date).getTime()}`)
  );

  // 3. Build docs to insert (only where no attendance exists and date >= joining date)
  const toInsert = [];
  for (const student of students) {
    const studentId = String(student._id);
    const studentEmail = student.user?.email ?? student.studentEmail ?? '';
    const joiningMidnight = student.joiningDate ? getUtcMidnight(student.joiningDate) : null;
    for (const hi of holidayInfos) {
      if (joiningMidnight && hi.normalizedDate < joiningMidnight) continue;
      const key = `${studentId}|${hi.normalizedDate.getTime()}`;
      if (existingKeySet.has(key)) continue;
      toInsert.push({
        student: studentId,
        studentEmail,
        date: hi.normalizedDate,
        day: getDayName(hi.normalizedDate),
        punchIn: hi.normalizedDate,
        punchOut: null,
        duration: null,
        timezone: 'UTC',
        notes: `Holiday: ${hi.title}`,
        status: 'Holiday',
        isActive: true,
      });
    }
  }

  const BULK_INSERT_CHUNK = 5000;
  let createdCount = 0;
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += BULK_INSERT_CHUNK) {
      const chunk = toInsert.slice(i, i + BULK_INSERT_CHUNK);
      await Attendance.insertMany(chunk);
      createdCount += chunk.length;
    }
  }

  const skippedCount = existingAttendances.length;
  const skippedSample =
    skippedCount > 0
      ? existingAttendances.slice(0, 50).map((r) => {
          const student = studentMap.get(String(r.student));
          const hi = holidayInfos.find((x) => x.normalizedDate.getTime() === new Date(r.date).getTime());
          return {
            studentId: String(r.student),
            studentName: student?.user?.name ?? student?.user?.email ?? 'Student',
            holidayId: hi?.holidayId,
            holidayTitle: hi?.title,
            date: new Date(r.date).toISOString(),
            reason: 'Attendance already exists for this date',
          };
        })
      : undefined;

  return {
    success: true,
    message: `Holidays added to ${students.length} student(s). Created ${createdCount} attendance record(s).`,
    data: {
      candidatesUpdated: students.length,
      holidaysAdded: holidayIds.length,
      attendanceRecordsCreated: createdCount,
      skippedCount,
      skipped: skippedSample,
      skippedTruncated: skippedCount > (skippedSample?.length ?? 0),
    },
  };
};

/**
 * Remove holidays from students (remove holiday IDs from students and delete Holiday attendance records).
 * Uses bulk DB operations so it scales to hundreds/thousands of students.
 */
const removeHolidaysFromStudents = async (studentIds, holidayIds, _user) => {
  const students = await Student.find({ _id: { $in: studentIds } }).populate('user', 'name email').lean();
  if (students.length !== studentIds.length) {
    const foundIds = students.map((s) => String(s._id));
    const missingIds = studentIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some students not found: ${missingIds.join(', ')}`);
  }

  const holidays = await Holiday.find({ _id: { $in: holidayIds } }).lean();
  if (holidays.length !== holidayIds.length) {
    const foundIds = holidays.map((h) => String(h._id));
    const missingIds = holidayIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some holidays not found: ${missingIds.join(', ')}`);
  }

  const normalizedDates = [];
  for (const h of holidays) {
    normalizedDates.push(...getHolidayDates(h));
  }

  // 1. Bulk update: remove holiday IDs from all students in one op
  await Student.updateMany({ _id: { $in: studentIds } }, { $pull: { holidays: { $in: holidayIds } } });

  // 2. Bulk delete: remove all Holiday attendance for these students and dates in one op
  const deleteResult = await Attendance.deleteMany({
    student: { $in: studentIds },
    status: 'Holiday',
    date: { $in: normalizedDates },
  });

  return {
    success: true,
    message: `Holidays removed from ${students.length} student(s). Deleted ${deleteResult.deletedCount} attendance record(s).`,
    data: {
      candidatesUpdated: students.length,
      holidaysRemoved: holidayIds.length,
      attendanceRecordsDeleted: deleteResult.deletedCount,
    },
  };
};

/**
 * Assign leave to students (create Attendance with status Leave for each student x date)
 * @param {Array<string>} studentIds
 * @param {Array<string|Date>} dates - ISO date strings or Date objects
 * @param {string} leaveType - 'casual' | 'sick' | 'unpaid'
 * @param {string} [notes]
 * @param {Object} user
 */
const assignLeavesToStudents = async (studentIds, dates, leaveType, notes, _user) => {
  const students = await Student.find({ _id: { $in: studentIds } })
    .select('joiningDate')
    .populate('user', 'name email');
  if (students.length !== studentIds.length) {
    const foundIds = students.map((s) => String(s._id));
    const missingIds = studentIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some students not found: ${missingIds.join(', ')}`);
  }
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one date is required');
  }
  if (!['casual', 'sick', 'unpaid'].includes(leaveType)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Leave type must be casual, sick, or unpaid');
  }

  const normalizedDates = dates
    .map((d) => {
      const date = new Date(d);
      if (isNaN(date.getTime())) throw new ApiError(httpStatus.BAD_REQUEST, `Invalid date: ${d}`);
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
    })
    .filter((date, i, self) => i === self.findIndex((d) => d.getTime() === date.getTime()))
    .sort((a, b) => a - b);

  const createdRecords = [];
  const skipped = [];
  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  for (const studentId of studentIds) {
    const student = studentMap.get(String(studentId));
    if (!student) continue;
    const studentName = student.user?.name ?? student.user?.email ?? 'Student';
    const studentEmail = student.user?.email ?? '';

    const joiningMidnight = student.joiningDate ? getUtcMidnight(student.joiningDate) : null;

    for (const date of normalizedDates) {
      const normalizedDate = new Date(date);
      const nextDay = new Date(normalizedDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);

      if (joiningMidnight && normalizedDate < joiningMidnight) {
        skipped.push({
          studentId,
          studentName,
          date: normalizedDate.toISOString(),
          reason: 'Date is before joining date',
        });
        continue;
      }

      const existing = await Attendance.findOne({
        student: studentId,
        date: { $gte: normalizedDate, $lt: nextDay },
      });
      if (existing) {
        skipped.push({
          studentId,
          studentName,
          date: normalizedDate.toISOString(),
          reason: 'Attendance already exists for this date',
        });
        continue;
      }

      const leaveLabel = leaveType.charAt(0).toUpperCase() + leaveType.slice(1);
      const noteText = notes ? `Leave: ${leaveLabel} - ${notes}` : `Leave: ${leaveLabel}`;

      const attendance = await Attendance.create({
        student: studentId,
        studentEmail,
        date: normalizedDate,
        day: getDayName(normalizedDate),
        punchIn: normalizedDate,
        punchOut: null,
        duration: null,
        timezone: 'UTC',
        notes: noteText,
        status: 'Leave',
        leaveType,
        isActive: true,
      });
      createdRecords.push({
        studentId,
        studentName,
        date: normalizedDate.toISOString(),
        leaveType,
        attendanceId: attendance._id,
      });
    }
  }

  return {
    success: true,
    message: `Leave assigned to ${students.length} student(s). Created ${createdRecords.length} attendance record(s).`,
    data: {
      candidatesUpdated: students.length,
      leaveType,
      attendanceRecordsCreated: createdRecords.length,
      createdRecords,
      skipped: skipped.length > 0 ? skipped : undefined,
    },
  };
};

const DAY_NAMES_ATTENDANCE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Best-effort message for per-entry failures in regularize (Mongoose / driver errors sometimes omit .message). */
const regularizeEntryErrorMessage = (err) => {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.trim()) return err.message;
  if (typeof err.toString === 'function') {
    const s = err.toString();
    if (s && s !== '[object Object]') return s;
  }
  return 'Unknown error';
};

/**
 * Regularize attendance: admin creates back-dated attendance records for a student.
 * @param {string} studentId
 * @param {Array} attendanceEntries - [{ date, punchIn, punchOut?, timezone?, notes? }] (ISO strings or Date)
 * @param {Object} user - must have students.manage (checked by route)
 */
const regularizeAttendance = async (studentId, attendanceEntries, _user) => {
  const student = await Student.findById(studentId)
    .populate('user', 'name email')
    .populate('shift', 'name timezone startTime endTime');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  const studentEmail = student.user?.email ?? student.email ?? '';
  const studentName = student.user?.name ?? '';
  const shift = student.shift && (student.shift.startTime || student.shift.timezone) ? student.shift : null;
  /* Do not enforce joiningDate here — punch-in still does. Regularize is an admin/agent override for corrections/backfill. */

  if (!Array.isArray(attendanceEntries) || attendanceEntries.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one attendance entry is required');
  }

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
  const createdOrUpdated = [];
  const errors = [];

  for (let i = 0; i < attendanceEntries.length; i++) {
    const entry = attendanceEntries[i];
    try {
      const dateObj = new Date(entry.date);
      if (isNaN(dateObj.getTime())) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Entry ${i + 1}: Invalid date`);
      }
      const utcYear = dateObj.getUTCFullYear();
      const utcMonth = dateObj.getUTCMonth();
      const utcDay = dateObj.getUTCDate();
      const normalizedDate = new Date(Date.UTC(utcYear, utcMonth, utcDay, 0, 0, 0, 0));

      if (normalizedDate >= todayUTC) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Entry ${i + 1}: Back-dated attendance must be for past dates only`);
      }

      let punchIn = new Date(entry.punchIn);
      if (isNaN(punchIn.getTime())) throw new ApiError(httpStatus.BAD_REQUEST, `Entry ${i + 1}: Invalid punchIn`);
      const punchInDate = new Date(normalizedDate);
      punchInDate.setUTCHours(punchIn.getUTCHours(), punchIn.getUTCMinutes(), punchIn.getUTCSeconds(), punchIn.getUTCMilliseconds());
      punchIn = punchInDate;

      let punchOut = null;
      if (entry.punchOut) {
        punchOut = new Date(entry.punchOut);
        if (isNaN(punchOut.getTime())) throw new ApiError(httpStatus.BAD_REQUEST, `Entry ${i + 1}: Invalid punchOut`);
        const punchOutDate = new Date(normalizedDate);
        punchOutDate.setUTCHours(punchOut.getUTCHours(), punchOut.getUTCMinutes(), punchOut.getUTCSeconds(), punchOut.getUTCMilliseconds());
        punchOut = punchOutDate;
        if (punchOut <= punchIn) {
          const punchInHour = punchIn.getUTCHours();
          const punchOutHour = punchOut.getUTCHours();
          const hoursDiff = (punchOutHour + 24 - punchInHour) % 24;
          const isNightShift = (punchInHour >= 12 && punchOutHour < 12) || (hoursDiff >= 1 && hoursDiff <= 16);
          if (isNightShift) punchOut.setUTCDate(punchOut.getUTCDate() + 1);
          else throw new ApiError(httpStatus.BAD_REQUEST, `Entry ${i + 1}: Punch out must be after punch in`);
        }
      }

      const nextDay = new Date(normalizedDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const timezone = entry.timezone || 'UTC';
      const notes = entry.notes != null ? String(entry.notes) : '';
      const status = punchOut ? 'Present' : 'Absent';
      const duration = punchOut ? computeDurationMs(punchIn, punchOut, shift) : 0;
      const day = DAY_NAMES_ATTENDANCE[normalizedDate.getUTCDay()];

      let attendance = await Attendance.findOne({
        student: studentId,
        date: { $gte: normalizedDate, $lt: nextDay },
      });

      if (attendance) {
        attendance.punchIn = punchIn;
        attendance.punchOut = punchOut;
        attendance.timezone = timezone;
        attendance.notes = notes;
        attendance.duration = duration;
        attendance.status = status;
        attendance.isActive = true;
        attendance.day = day;
        if (!attendance.studentName && studentName) attendance.studentName = studentName;
        if (!attendance.studentEmail && studentEmail) attendance.studentEmail = studentEmail;
        await attendance.save();
        createdOrUpdated.push(attendance);
      } else {
        attendance = await Attendance.create({
          student: studentId,
          studentEmail,
          studentName,
          date: normalizedDate,
          day,
          punchIn,
          punchOut,
          timezone,
          notes,
          duration,
          status,
          isActive: true,
        });
        createdOrUpdated.push(attendance);
      }
    } catch (err) {
      errors.push({
        entryIndex: i + 1,
        date: entry.date,
        error: regularizeEntryErrorMessage(err),
      });
    }
  }

  if (createdOrUpdated.length === 0 && errors.length > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Failed to add attendance: ${errors.map((e) => `${e.date} (${e.error ?? e.reason ?? 'Unknown'})`).join('; ')}`
    );
  }

  return {
    createdOrUpdated: createdOrUpdated.length,
    errors: errors.length > 0 ? errors : undefined,
  };
};

export default {
  punchIn,
  punchOut,
  getCurrentPunchStatus,
  punchInByUser,
  punchOutByUser,
  getCurrentPunchStatusByUser,
  listByUser,
  getStatisticsByUser,
  listByStudent,
  getStatistics,
  getTrackList,
  getTrackHistory,
  findAllActivePunchIns,
  autoPunchOut,
  getUtcMidnight,
  getLocalMidnightAndDay,
  addHolidaysToStudents,
  removeHolidaysFromStudents,
  assignLeavesToStudents,
  regularizeAttendance,
};
