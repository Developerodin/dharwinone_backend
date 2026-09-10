/**
 * Regression tests: approving a backdated request must own the whole attendance day.
 *
 * The bug this pins: `punchIn` files every completed session as its own Attendance row, but
 * approve used a single `findOne` and rewrote one arbitrary row for the day. Every other
 * session survived, and the calendar sums sessions per day — so an approved 09:00–17:00
 * request rendered as 16h, clamped by the client to a flat "14h 0m".
 *
 * All DB/permission dependencies are mocked; the assertions are about which rows approve
 * touches, not about Mongo.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/** An Attendance row as approve will see it. */
const makeRow = (id, { isActive = true, status = 'Present', leaveType = null } = {}) => ({
  _id: id,
  isActive,
  status,
  leaveType,
  saved: false,
  async save() {
    this.saved = true;
  },
  populate() {
    return this;
  },
});

let attendanceRows = [];
let updateManyCalls = [];
let createdRows = [];

function AttendanceStub(doc) {
  const row = { ...makeRow(doc._id ?? 'new'), ...doc };
  createdRows.push(row);
  return row;
}
AttendanceStub.find = () => ({
  sort: async () => attendanceRows,
});
AttendanceStub.updateMany = async (filter, update) => {
  updateManyCalls.push({ filter, update });
};
AttendanceStub.findOne = async () => null;

const savedRequest = {};
const requestStub = {
  findById: () => ({
    populate: () => ({
      populate: () => savedRequest.doc,
    }),
  }),
  populate: async () => {},
};

const modelStub = {
  findById: () => null,
  findOne: () => null,
  find: () => null,
  create: () => null,
  populate: () => null,
  paginate: () => null,
};

mock.module('../../models/backdatedAttendanceRequest.model.js', { defaultExport: requestStub });
mock.module('../../models/attendance.model.js', { defaultExport: AttendanceStub });
mock.module('../../models/student.model.js', { defaultExport: modelStub });
mock.module('../../models/user.model.js', { defaultExport: modelStub });
mock.module('../permission.service.js', {
  namedExports: { getUserPermissionContext: async () => ({ permissions: new Set() }) },
});
mock.module('../attendancePolicy.service.js', {
  namedExports: { findBlockedAttendanceDays: async () => [] },
});
mock.module('../../utils/roleHelpers.js', { namedExports: { userIsAdminOrAgent: async () => false } });
mock.module('../notification.service.js', {
  namedExports: { notifyByEmail: async () => {}, plainTextEmailBody: () => '' },
});

let approveBackdatedAttendanceRequest;
test.before(async () => {
  ({ approveBackdatedAttendanceRequest } = await import('../backdatedAttendanceRequest.service.js'));
});

/** A pending student-based request for one 8h day. */
const makeRequest = () => ({
  _id: 'req1',
  status: 'pending',
  student: { _id: 'stu1' },
  studentEmail: 'employee@example.test',
  user: undefined,
  notes: 'missed punch',
  attendanceEntries: [
    {
      date: new Date('2026-06-22T00:00:00.000Z'),
      punchIn: new Date('2026-06-22T09:00:00.000Z'),
      punchOut: new Date('2026-06-22T17:00:00.000Z'),
      timezone: 'America/Chicago',
    },
  ],
  async save() {
    this.saved = true;
  },
});

const reviewer = { id: 'admin1', platformSuperUser: true };

const runApprove = async (rows) => {
  attendanceRows = rows;
  updateManyCalls = [];
  createdRows = [];
  savedRequest.doc = makeRequest();
  await approveBackdatedAttendanceRequest('req1', null, reviewer);
};

test('rewrites the first row and deactivates every other session on the day', async () => {
  const kept = makeRow('a');
  const extra1 = makeRow('b');
  const extra2 = makeRow('c');
  await runApprove([kept, extra1, extra2]);

  assert.equal(kept.saved, true, 'the kept row is rewritten');
  assert.equal(kept.status, 'Present');
  assert.equal(kept.duration, 8 * 60 * 60 * 1000, 'duration is the requested 8h, not a sum');
  assert.equal(kept.isActive, true);

  assert.equal(updateManyCalls.length, 1, 'the leftover sessions are claimed in one write');
  assert.deepEqual(updateManyCalls[0].filter, { _id: { $in: ['b', 'c'] } });
  assert.deepEqual(updateManyCalls[0].update, { $set: { isActive: false } });
});

test('a day with exactly one row issues no deactivation write', async () => {
  const only = makeRow('a');
  await runApprove([only]);

  assert.equal(only.saved, true);
  assert.equal(updateManyCalls.length, 0, 'nothing to supersede');
});

test('a day with no rows creates one and deactivates nothing', async () => {
  await runApprove([]);

  assert.equal(createdRows.length, 1, 'a fresh row is created for the day');
  assert.equal(createdRows[0].status, 'Present');
  assert.equal(updateManyCalls.length, 0);
});

test('overwriting a Leave day clears leaveType so the row is not Present-with-a-leave-type', async () => {
  const leaveRow = makeRow('a', { status: 'Leave', leaveType: 'casual' });
  await runApprove([leaveRow]);

  assert.equal(leaveRow.status, 'Present');
  assert.equal(leaveRow.leaveType, null, 'stale leaveType must not survive the status change');
});
