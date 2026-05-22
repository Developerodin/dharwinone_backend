/**
 * P2 Regression Tests: attendancePolicy.service.js
 *
 * Validates the attendance policy engine — holiday detection, week-off detection,
 * leave detection, and the validatePunchIn / validatePunchOut decision objects.
 * All external dependencies (Student, Attendance, Holiday) are mocked.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ----- mutable mock state -----
let studentRow = null;
let attendanceRow = null;

/**
 * Build a chainable stub: .populate(...).lean() → value
 * Any number of .populate() calls are swallowed; the final .lean() resolves.
 */
const chainable = (value) => {
  const stub = {
    populate: () => stub,
    lean: async () => value,
  };
  return stub;
};

mock.module('../../models/student.model.js', {
  defaultExport: {
    // Late-binding: arrow fn captures by reference so value of studentRow at call time is used.
    findById: (_id) => chainable(studentRow),
  },
});
mock.module('../../models/attendance.model.js', {
  defaultExport: {
    findOne: (_query) => {
      const stub = {
        sort: () => stub,
        lean: async () => attendanceRow,
      };
      return stub;
    },
  },
});
mock.module('../../models/holiday.model.js', {
  defaultExport: {
    find: () => ({ lean: async () => [] }),
  },
});
// ApiError is a real class — allow it through unchanged.
mock.module('../../utils/ApiError.js', {
  defaultExport: class ApiError extends Error {
    constructor(status, msg, isOp = false, _stack = '', code = '') {
      super(msg);
      this.statusCode = status;
      this.isOperational = isOp;
      this.errorCode = code;
    }
  },
});

let validatePunchIn;
let validatePunchOut;
let isHoliday;
let isWeekOff;
let resolveAttendanceDay;

test.before(async () => {
  const mod = await import('../attendancePolicy.service.js');
  ({
    validatePunchIn,
    validatePunchOut,
    isHoliday,
    isWeekOff,
    resolveAttendanceDay,
  } = mod);
});

// ---- unit: resolveAttendanceDay ----

test('resolveAttendanceDay — UTC date derivation is correct', () => {
  const instant = new Date('2025-06-15T14:30:00Z'); // Sunday UTC
  const { midnight, day } = resolveAttendanceDay(instant, 'UTC');
  assert.equal(midnight.toISOString(), '2025-06-15T00:00:00.000Z');
  assert.equal(day, 'Sunday');
});

test('resolveAttendanceDay — IST +05:30 crosses midnight correctly', () => {
  // 2025-06-15T20:00:00Z = 2025-06-16T01:30:00+05:30 → local date is June 16 (Monday)
  const instant = new Date('2025-06-15T20:00:00Z');
  const { midnight, day } = resolveAttendanceDay(instant, 'Asia/Kolkata');
  assert.equal(midnight.toISOString(), '2025-06-16T00:00:00.000Z');
  assert.equal(day, 'Monday');
});

// ---- unit: isWeekOff ----

test('isWeekOff — detects configured week-off day', () => {
  const student = { weekOff: ['Saturday', 'Sunday'] };
  assert.equal(isWeekOff(student, 'Saturday').blocked, true);
  assert.equal(isWeekOff(student, 'Monday').blocked, false);
});

test('isWeekOff — returns blocked:false when student has no weekOff', () => {
  assert.equal(isWeekOff({}, 'Saturday').blocked, false);
});

// ---- unit: isHoliday ----

test('isHoliday — detects assigned holiday on that date', () => {
  const localMidnight = new Date('2025-08-15T00:00:00.000Z');
  const student = {
    holidays: [
      {
        date: new Date('2025-08-15T00:00:00.000Z'),
        endDate: new Date('2025-08-15T00:00:00.000Z'),
        isActive: true,
        title: 'Independence Day',
      },
    ],
  };
  const result = isHoliday(student, localMidnight);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'HOLIDAY_BLOCKED');
});

test('isHoliday — returns blocked:false when date is not in holiday list', () => {
  const localMidnight = new Date('2025-08-16T00:00:00.000Z');
  const student = {
    holidays: [
      {
        date: new Date('2025-08-15T00:00:00.000Z'),
        endDate: new Date('2025-08-15T00:00:00.000Z'),
        isActive: true,
        title: 'Independence Day',
      },
    ],
  };
  assert.equal(isHoliday(student, localMidnight).blocked, false);
});

// ---- integration: validatePunchIn ----

test('validatePunchIn — allowed:true on a normal working day (Monday)', async () => {
  studentRow = { _id: 'stu1', weekOff: ['Sunday'], holidays: [], shift: null };
  attendanceRow = null;

  const monday = new Date('2025-06-16T09:00:00Z');
  const result = await validatePunchIn('stu1', monday, 'UTC');
  assert.equal(result.allowed, true);
});

test('validatePunchIn — allowed:false on week-off day (Sunday)', async () => {
  studentRow = { _id: 'stu2', weekOff: ['Sunday'], holidays: [], shift: null };
  attendanceRow = null;

  const sunday = new Date('2025-06-15T09:00:00Z');
  const result = await validatePunchIn('stu2', sunday, 'UTC');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'WEEK_OFF_BLOCKED');
});

test('validatePunchIn — throws ApiError when student not found', async () => {
  studentRow = null;
  attendanceRow = null;

  await assert.rejects(
    () => validatePunchIn('ghost', new Date(), 'UTC'),
    (err) => {
      assert.ok(err.statusCode === 404 || err.message.toLowerCase().includes('not found'));
      return true;
    }
  );
});

// ---- integration: validatePunchOut ----

test('validatePunchOut — allowed:false when no active punch-in exists', async () => {
  studentRow = { _id: 'stu3', weekOff: [], holidays: [], shift: null };
  attendanceRow = null; // no open punch record

  const result = await validatePunchOut('stu3', new Date(), 'UTC');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'NO_ACTIVE_PUNCH');
});

test('validatePunchOut — allowed:true when active punch-in exists', async () => {
  studentRow = { _id: 'stu4', weekOff: [], holidays: [], shift: null };
  // active = has punchIn but no punchOut
  attendanceRow = {
    _id: 'att1',
    student: 'stu4',
    punchIn: new Date('2025-06-16T09:00:00Z'),
    punchOut: null,
  };

  const result = await validatePunchOut('stu4', new Date('2025-06-16T18:00:00Z'), 'UTC');
  assert.equal(result.allowed, true);
});
