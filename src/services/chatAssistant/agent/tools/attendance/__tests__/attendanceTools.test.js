import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getAttendance from '../getAttendance.tool.js';
import getAttendanceSummary from '../getAttendanceSummary.tool.js';
import countLeaveRequests from '../countLeaveRequests.tool.js';
import listLeaveRequests from '../listLeaveRequests.tool.js';
import whoIsOnLeaveToday from '../whoIsOnLeaveToday.tool.js';
import listBackdatedRequests from '../listBackdatedRequests.tool.js';

const PLAIN = { id: 'u1', _id: 'u1', name: 'Me', authContext: { permissions: new Set() } };
const HR = { id: 'hr', _id: 'hr', name: 'HR', authContext: { permissions: new Set(['students.manage']) } };

const chain = (rows) => ({ select: () => ({ limit: () => ({ lean: async () => rows }), lean: async () => rows }) });

function ctxFor(user, over = {}) {
  return {
    user,
    requestId: 'r',
    deps: {
      Student: { find: (q) => chain(q.user === 'u1' ? [{ _id: 's-self' }] : [{ _id: `s-${q.user}` }]) },
      Employee: { find: () => chain([{ owner: 'o9', fullName: 'Saad Khan', employeeId: 'DBS9' }]) },
      ...over,
    },
  };
}

describe('get_attendance', () => {
  it('defaults to the viewer and reads their Student attendance through the service', async () => {
    let seen;
    const out = await getAttendance.execute({ window: { from: '2026-09-01', to: '2026-09-02' } }, ctxFor(PLAIN, {
      listByStudent: async (sid, q) => {
        seen = { sid, q };
        return { totalResults: 2, results: [
          { date: '2026-09-02T00:00:00.000Z', status: 'Present', punchIn: '2026-09-02T04:00:00Z', duration: 3600000 },
          { date: '2026-09-01T00:00:00.000Z', status: 'Leave', leaveType: 'sick', punchIn: '2026-09-01T00:00:00.000Z' },
        ] };
      },
    }));
    assert.equal(seen.sid, 's-self');
    assert.equal(seen.q.startDate, '2026-09-01');
    assert.equal(out.person.self, true);
    assert.deepEqual(out.statusBreakdown, { Present: 1, Leave: 1 });
    assert.equal(out.records[0].punchIn, '09:30');
    assert.equal(out.records[0].hours, 1);
    // Leave rows carry a midnight placeholder punchIn — never shown as a 05:30 punch.
    assert.equal(out.records[1].punchIn, null);
  });

  it('refuses another person for a viewer without students/candidates read (B3: permission, not role name)', async () => {
    const out = await getAttendance.execute({ person: 'Saad' }, ctxFor(PLAIN));
    assert.match(out.error, /only see your own/);
  });

  it('lets students.manage read a named person, falling back to user rows without a Student', async () => {
    let seenUser;
    const out = await getAttendance.execute({ person: 'Saad' }, ctxFor(HR, {
      Student: { find: () => chain([]) },
      listByUser: async (uid) => { seenUser = uid; return { totalResults: 0, results: [] }; },
    }));
    assert.equal(seenUser, 'o9');
    assert.equal(out.person.name, 'Saad Khan');
  });

  it('rejects a malformed day through the shared dayRange validator', async () => {
    await assert.rejects(getAttendance.execute({ window: { from: '2026-13-01', to: '2026-13-02' } }, ctxFor(PLAIN, {
      listByStudent: async () => ({ results: [] }),
    })), /Invalid date/);
  });
});

describe('get_attendance_summary', () => {
  it('is gated on students.manage (Track page)', () => {
    assert.deepEqual(getAttendanceSummary.access.anyOf, ['students.manage']);
  });

  it('passes UTC-midnight day keys and no adminId to the aggregator', async () => {
    let seen;
    const out = await getAttendanceSummary.execute({ window: { from: '2026-09-01', to: '2026-09-02' } }, ctxFor(HR, {
      aggregateOrgAttendance: async (a) => {
        seen = a;
        return { total: 3, employees: [], perDay: [
          { date: '2026-09-01', counts: { Present: 2 } }, { date: '2026-09-02', counts: { Present: 1 } },
        ] };
      },
    }));
    assert.equal(seen.from.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal('adminId' in seen, false);
    assert.equal(out.total, 3);
    assert.equal(out.avgDailyPresent, 1.5);
  });

  it('short-circuits a future window', async () => {
    const out = await getAttendanceSummary.execute({ window: { from: '2999-01-01', to: '2999-01-01' } }, ctxFor(HR));
    assert.equal(out.futureDate, true);
  });
});

describe('leave requests', () => {
  const leaveDeps = (scopeFilter, captured) => ({
    buildLeaveRequestScopeFilter: async () => ({ filter: scopeFilter }),
    LeaveRequest: {
      countDocuments: async (m) => { captured.count = m; return 4; },
      aggregate: async (p) => { captured.pipeline = p; return [{ _id: 'pending', count: 3 }, { _id: 'approved', count: 1 }]; },
    },
  });

  it('count ANDs the page scope with the filters and returns a status breakdown', async () => {
    const cap = {};
    const out = await countLeaveRequests.execute(
      { filters: { status: 'pending', dates: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxFor(PLAIN, leaveDeps({ student: { $in: ['s-self'] } }, cap)),
    );
    assert.deepEqual(cap.count.$and[0], { student: { $in: ['s-self'] } });
    assert.ok(cap.count.$and.some((c) => c.dates?.$elemMatch));
    assert.equal(out.total, 4);
    assert.equal(out.breakdown.pending, 3);
  });

  it('a viewer with no Student profile gets 0, never an unfiltered count', async () => {
    const cap = {};
    const out = await countLeaveRequests.execute({}, ctxFor(PLAIN, leaveDeps(null, cap)));
    assert.equal(out.total, 0);
    assert.equal(cap.count, undefined);
  });

  it('groupBy employee needs a window and ranks approved leave days by default', async () => {
    const cap = {};
    const none = await countLeaveRequests.execute({ groupBy: 'employee' }, ctxFor(HR, leaveDeps({}, cap)));
    assert.match(none.error, /needs filters.dates/);
    const deps = leaveDeps({}, cap);
    deps.LeaveRequest.aggregate = async (p) => {
      cap.pipeline = p;
      return [{ name: 'Saad', leaveDays: 4, requestCount: 2, leaveTypes: ['sick'] }];
    };
    const out = await countLeaveRequests.execute(
      { groupBy: 'employee', filters: { dates: { from: '2026-09-01', to: '2026-09-30' } } }, ctxFor(HR, deps),
    );
    assert.equal(cap.pipeline[0].$match.status, 'approved');
    assert.equal(out.groups[0].rank, 1);
    assert.equal(out.statusCounted, 'approved');
  });

  it('list passes the viewer to queryLeaveRequests and keeps the person inside $and', async () => {
    let seen;
    const out = await listLeaveRequests.execute({ filters: { person: 'Saad' } }, ctxFor(HR, {
      queryLeaveRequests: async (filter, opts, user) => {
        seen = { filter, opts, user };
        return { totalResults: 1, results: [{
          _id: 'l1', leaveType: 'sick', status: 'approved', student: { user: { name: 'Saad Khan' } },
          dates: ['2026-09-03T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
        }] };
      },
    }));
    assert.equal(seen.user, HR);
    assert.deepEqual(seen.filter.$and[0], { student: { $in: ['s-o9'] } });
    assert.deepEqual(out.records[0], {
      id: 'l1', person: 'Saad Khan', leaveType: 'sick', status: 'approved', from: '2026-09-02', to: '2026-09-03',
      days: 2, reviewedBy: null, requestedAt: null,
    });
  });

  it('mine pins the list to the viewer\'s own Student even for an admin', async () => {
    let seen;
    await listLeaveRequests.execute({ filters: { mine: true } }, ctxFor(HR, {
      Student: { find: () => chain([{ _id: 's-hr' }]) },
      queryLeaveRequests: async (filter) => { seen = filter; return { totalResults: 0, results: [] }; },
    }));
    assert.deepEqual(seen.$and[0], { student: { $in: ['s-hr'] } });
  });
});

describe('who_is_on_leave_today', () => {
  it('wraps the dashboard service with the viewer', async () => {
    let seen;
    const out = await whoIsOnLeaveToday.execute({}, ctxFor(PLAIN, {
      getEmployeesOnLeaveToday: async (u) => {
        seen = u;
        return { scope: 'self', results: [{
          name: 'Me', employeeId: 'DBS1', leaveType: 'sick',
          startDate: '2026-09-29T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z',
        }] };
      },
    }));
    assert.equal(seen, PLAIN);
    assert.equal(out.total, 1);
    assert.equal(out.records[0].to, '2026-09-30');
  });
});

describe('list_backdated_requests', () => {
  it('never sets a bare filter.student and returns a per-status breakdown', async () => {
    const filters = [];
    const out = await listBackdatedRequests.execute({ filters: { person: 'Saad' } }, ctxFor(HR, {
      queryBackdatedAttendanceRequests: async (f, opts) => {
        filters.push(f);
        return { totalResults: opts.limit === 1 ? 2 : 8, results: opts.limit === 1 ? [] : [
          { _id: 'b1', status: 'pending', user: { name: 'Saad Khan' }, attendanceEntries: [{ date: '2026-09-05T00:00:00Z' }] },
        ] };
      },
    }));
    assert.ok(filters.every((f) => !('student' in f)));
    assert.deepEqual(filters[0].$and[0].$or[0], { user: 'o9' });
    assert.equal(out.total, 8);
    assert.deepEqual(out.breakdown, { pending: 2, approved: 2, rejected: 2, cancelled: 2 });
    assert.equal(out.records[0].from, '2026-09-05');
  });
});
