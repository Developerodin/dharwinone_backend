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

  it('never resolves a candidate profile to the recruiter who merely owns it; a user id resolves directly', async () => {
    const REC = '64b7f0c2a1b2c3d4e5f60009';
    const profiles = [
      { owner: REC, fullName: 'Kiran Rao', employeeId: null, email: 'kiran@x.com' },
      { owner: REC, fullName: 'Rec Ruiter', employeeId: 'DBS3', email: 'rec@x.com' },
    ];
    const users = {
      find: () => chain([{ _id: REC, email: 'rec@x.com' }]),
      findById: () => ({ select: () => ({ lean: async () => ({ _id: REC, name: 'Rec Login' }) }) }),
    };
    const base = {
      // The name search hits only Kiran's profile; the per-owner count sees both.
      Employee: { find: (q) => chain(q.$or ? [profiles[0]] : profiles), findOne: () => chain(profiles[1]) },
      User: users,
      listByStudent: async () => ({ totalResults: 0, results: [] }),
    };
    const kiran = await getAttendance.execute({ person: 'Kiran Rao' }, ctxFor(HR, base));
    assert.equal(kiran.notFound, 'person');
    const byId = await getAttendance.execute({ person: REC }, ctxFor(HR, base));
    assert.equal(byId.person.name, 'Rec Login');
    assert.equal(byId.person.employeeId, 'DBS3');
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

  it('today is the IST day: 02:00 IST on 1 Oct is still 30 Sep in UTC, but 1 Oct is not in the future', async () => {
    const out = await getAttendanceSummary.execute({ window: { from: '2026-10-01', to: '2026-10-01' } }, ctxFor(HR, {
      now: () => new Date('2026-09-30T20:30:00.000Z'),
      aggregateOrgAttendance: async () => ({ total: 0, perDay: [], employees: [] }),
    }));
    assert.equal(out.futureDate, undefined);
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
      days: 2, reviewedBy: null, requestedAt: null, adminComment: null,
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
    assert.equal(out.records[0].notes, null);
    assert.equal(out.records[0].adminComment, null);
  });

  it('returns the note and reviewer comment the Backdated page shows, and null when blank', async () => {
    const out = await listBackdatedRequests.execute({}, ctxFor(PLAIN, {
      queryBackdatedAttendanceRequests: async () => ({
        totalResults: 2,
        results: [
          { _id: 'b1', status: 'rejected', notes: '  Forgot to punch out  ', adminComment: 'Not a working day', attendanceEntries: [] },
          { _id: 'b2', status: 'pending', notes: '   ', adminComment: '', attendanceEntries: [] },
        ],
      }),
    }));
    assert.equal(out.records[0].notes, 'Forgot to punch out');
    assert.equal(out.records[0].adminComment, 'Not a working day');
    assert.equal(out.records[1].notes, null);
    assert.equal(out.records[1].adminComment, null);
    assert.equal(out.records.length, 2);
  });
});

const found = (rows) => ({ select: () => ({ lean: async () => rows }) });
const HR_TEAMS = {
  id: 'hr', _id: 'hr', name: 'HR',
  authContext: { permissions: new Set(['students.manage', 'teams.read']) },
};

describe('comments and grouping', () => {
  it('returns adminComment for every leave row the page returns, and null when none was recorded', async () => {
    let seenUser;
    const out = await listLeaveRequests.execute({}, ctxFor(PLAIN, {
      queryLeaveRequests: async (_filter, _opts, user) => {
        seenUser = user;
        return { totalResults: 2, results: [
          { _id: 'l1', status: 'rejected', leaveType: 'sick', adminComment: '  Dates clash  ', dates: ['2026-09-02T00:00:00.000Z'], student: { user: { name: 'Me' } } },
          { _id: 'l2', status: 'approved', leaveType: 'casual', adminComment: '  ', dates: ['2026-09-03T00:00:00.000Z'], student: { user: { name: 'Me' } } },
        ] };
      },
    }));
    assert.equal(seenUser, PLAIN);
    assert.equal(out.records[0].adminComment, 'Dates clash');
    assert.equal(out.records[1].adminComment, null);
    assert.equal(out.records.some((r) => r.id === 'l-hidden'), false);
  });

  it('groups one day by department from the employee profile and hides profiles the summary did not return', async () => {
    let calls = 0;
    let teamReads = 0;
    const out = await getAttendanceSummary.execute(
      { window: { from: '2026-09-01', to: '2026-09-01' }, groupBy: 'department' },
      ctxFor(HR, {
        aggregateOrgAttendance: async () => {
          calls += 1;
          return { total: 3, perDay: [{ date: '2026-09-01', counts: { Present: 2, Absent: 1 } }], employees: [
            { employeeId: 'DBS1', email: 'a@x.com', name: 'Asha', status: 'Present' },
            { employeeId: 'DBS2', email: 'b@x.com', name: 'Vikram', status: 'Absent' },
            { name: 'No Id', status: 'Present' },
          ] };
        },
        Employee: { find: () => found([
          { _id: 'e1', employeeId: 'DBS1', email: 'a@x.com', department: 'Engineering' },
          { _id: 'e2', employeeId: 'DBS2', email: 'b@x.com', department: '  ' },
          { _id: 'e9', employeeId: 'DBS9', email: 'x@x.com', department: 'Sales' },
        ]) },
        TeamMember: { find: () => { teamReads += 1; return found([]); } },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(teamReads, 0);
    assert.equal(out.groups[0].value, 'Engineering');
    assert.equal(out.groups[0].attendancePct, 100);
    const unset = out.groups.find((g) => g.value === 'Not set');
    assert.equal(unset.people, 2);
    assert.equal(unset.present, 1);
    assert.equal(unset.absent, 1);
    assert.equal(out.groups.some((g) => g.value === 'Sales'), false);
  });

  it('uses department and owner stamped on the summary row when employeeId is missing', async () => {
    const out = await getAttendanceSummary.execute(
      { window: { from: '2026-09-01', to: '2026-09-01' }, groupBy: 'department' },
      ctxFor(HR, {
        aggregateOrgAttendance: async () => ({ total: 1, perDay: [], employees: [
          { owner: 'o1', department: 'Engineering', name: 'Asha', status: 'Present' },
        ] }),
        Employee: { find: () => found([]) },
      }),
    );
    assert.equal(out.groups[0].value, 'Engineering');
    assert.equal(out.groups[0].present, 1);
  });

  it('refuses team grouping without teams.read and does not read attendance', async () => {
    let calls = 0;
    const out = await getAttendanceSummary.execute(
      { window: { from: '2026-09-01', to: '2026-09-01' }, groupBy: 'team' },
      ctxFor(HR, { aggregateOrgAttendance: async () => { calls += 1; return {}; } }),
    );
    assert.match(out.error, /teams\.read/);
    assert.equal(calls, 0);
  });

  it('counts a person in each active workforce team and leaves attendancePct null when there is no working day', async () => {
    const out = await getAttendanceSummary.execute(
      { window: { from: '2026-09-01', to: '2026-09-01' }, groupBy: 'team' },
      ctxFor(HR_TEAMS, {
        aggregateOrgAttendance: async () => ({ total: 2, perDay: [], employees: [
          { employeeId: 'DBS1', status: 'WeekOff', name: 'Asha' },
          { employeeId: 'DBS2', status: 'Present', name: 'Vikram' },
        ] }),
        Employee: { find: () => found([
          { _id: 'e1', employeeId: 'DBS1', department: 'Engineering', email: 'a@x.com' },
          { _id: 'e2', employeeId: 'DBS2', department: 'Sales', email: 'b@x.com' },
        ]) },
        TeamMember: { find: (q) => found([
          { employeeId: 'e1', teamId: 't1', isActive: true },
          { employeeId: 'e1', teamId: 't2', isActive: true },
          { employeeId: 'e1', teamId: 't3', isActive: false },
        ].filter((m) => (q.isActive?.$ne === false ? m.isActive !== false : true))) },
        Team: { find: () => found([
          { _id: 't1', name: 'Platform' }, { _id: 't2', name: 'Delivery' }, { _id: 't3', name: 'Archived' },
        ]) },
      }),
    );
    assert.match(out.note, /each team/);
    const platform = out.groups.find((g) => g.value === 'Platform');
    const delivery = out.groups.find((g) => g.value === 'Delivery');
    assert.equal(platform.attendancePct, null);
    assert.equal(platform.weekOff, 1);
    assert.equal(delivery.weekOff, 1);
    assert.equal(out.groups.find((g) => g.value === 'Archived'), undefined);
    assert.equal(out.groups.find((g) => g.value === 'Not set').present, 1);
  });

  it('re-reads each day without the status filter so the employee list does not shrink the groups', async () => {
    const calls = [];
    const out = await getAttendanceSummary.execute({
      window: { from: '2026-09-01', to: '2026-09-02' },
      status: 'Absent',
      groupBy: 'department',
    }, ctxFor(HR, {
      aggregateOrgAttendance: async (a) => {
        calls.push({ statusFilter: a.statusFilter, from: a.from.toISOString().slice(0, 10), to: a.to.toISOString().slice(0, 10) });
        return {
          total: 1, perDay: [], employees: a.statusFilter ? [] : [
            { employeeId: 'DBS1', status: 'Present', name: 'Asha' },
          ],
        };
      },
      Employee: { find: () => found([{ _id: 'e1', employeeId: 'DBS1', department: 'Engineering', email: 'a@x.com' }]) },
    }));
    assert.deepEqual(calls[0], { statusFilter: 'Absent', from: '2026-09-01', to: '2026-09-02' });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].statusFilter, undefined);
    assert.equal(calls[2].statusFilter, undefined);
    assert.equal(out.groups[0].present, 2);
  });

  it('lets a platform super user group attendance by team', async () => {
    const out = await getAttendanceSummary.execute(
      { window: { from: '2026-09-01', to: '2026-09-01' }, groupBy: 'team' },
      ctxFor({ id: 'su', _id: 'su', platformSuperUser: true, authContext: { permissions: new Set() } }, {
        aggregateOrgAttendance: async () => ({ total: 0, perDay: [], employees: [] }),
        Employee: { find: () => found([]) },
      }),
    );
    assert.equal(out.error, undefined);
    assert.equal(out.groupBy, 'team');
    assert.deepEqual(out.groups, []);
  });

  it('groups leave by department inside the page scope and uses Not set when the profile has no department', async () => {
    const cap = {};
    const out = await countLeaveRequests.execute({ groupBy: 'department' }, ctxFor(PLAIN, {
      buildLeaveRequestScopeFilter: async () => ({ filter: { student: { $in: ['s1'] } } }),
      LeaveRequest: { find: (q) => { cap.query = q; return found([
        { student: 's1', dates: ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'] },
        { student: 's2', dates: ['2026-09-03T00:00:00.000Z'] },
      ]); } },
      Student: { find: () => found([
        { _id: 's1', user: 'u1' },
        { _id: 's2', user: 'u2' },
        { _id: 's-other', user: 'u-other' },
      ]) },
      Employee: { find: () => found([
        { _id: 'e1', owner: 'u1', department: 'Engineering' },
        { _id: 'e2', owner: 'u2', department: null },
        { _id: 'e-other', owner: 'u-other', department: 'Secret' },
      ]) },
    }));
    assert.deepEqual(cap.query.$and[0], { student: { $in: ['s1'] } });
    assert.equal(out.total, 2);
    assert.equal(out.groups.find((g) => g.value === 'Engineering').leaveDays, 2);
    assert.equal(out.groups.find((g) => g.value === 'Not set').count, 1);
    assert.equal(out.groups.some((g) => g.value === 'Secret'), false);
    assert.equal(out.groups.reduce((s, g) => s + g.count, 0), out.total);
  });

  it('does not query leave rows when the viewer has no Student profile', async () => {
    const out = await countLeaveRequests.execute({ groupBy: 'department' }, ctxFor(PLAIN, {
      buildLeaveRequestScopeFilter: async () => ({ filter: null }),
      LeaveRequest: { find: () => { throw new Error('unfiltered leave query'); } },
    }));
    assert.equal(out.total, 0);
  });

  it('refuses leave grouping by team without teams.read', async () => {
    const out = await countLeaveRequests.execute({ groupBy: 'team' }, ctxFor(HR));
    assert.match(out.error, /teams\.read/);
  });

  it('counts one leave request in each team and clips leave days to the window', async () => {
    const out = await countLeaveRequests.execute({
      groupBy: 'team',
      filters: { status: 'approved', dates: { from: '2026-09-01', to: '2026-09-01' } },
    }, ctxFor(HR_TEAMS, {
      buildLeaveRequestScopeFilter: async () => ({ filter: { student: { $in: ['s1'] } } }),
      LeaveRequest: { find: (q) => found(
        q.$and.some((c) => c.status === 'approved')
          ? [{ student: 's1', dates: ['2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'] }]
          : [],
      ) },
      Student: { find: () => found([{ _id: 's1', user: 'u1' }]) },
      Employee: { find: () => found([{ _id: 'e1', owner: 'u1', department: 'Engineering' }]) },
      TeamMember: { find: () => found([
        { employeeId: 'e1', teamId: 't1' },
        { employeeId: 'e1', teamId: 't2' },
      ]) },
      Team: { find: () => found([{ _id: 't1', name: 'Platform' }, { _id: 't2', name: 'Delivery' }]) },
    }));
    assert.equal(out.total, 1);
    assert.equal(out.groups.length, 2);
    assert.ok(out.groups.every((g) => g.count === 1 && g.leaveDays === 1));
    assert.match(out.note, /do not add up to total/);
  });
});
