import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getWorkSchedule from '../getWorkSchedule.tool.js';
import listShifts from '../listShifts.tool.js';
import listHolidays from '../listHolidays.tool.js';
import { matchesTurn } from '../index.js';
import { matchesTurn as orgMatchesTurn } from '../../org/index.js';

const USER_ID = '64b7f0c2a1b2c3d4e5f60001';
const perms = (...p) => ({ id: USER_ID, name: 'Asha', authContext: { permissions: new Set(p) } });

const future = (days) => new Date(Date.now() + days * 86400000);
const past = (days) => new Date(Date.now() - days * 86400000);

/** Model stub: findOne(filter) → chain → lean() returns byFilter(filter). */
function fakeModel(byFilter) {
  const calls = [];
  return {
    calls,
    findOne(filter) {
      calls.push(filter);
      const q = { select: () => q, populate: () => q, lean: async () => byFilter(filter) };
      return q;
    },
  };
}

const PROFILE = {
  _id: 'e1',
  owner: USER_ID,
  fullName: 'Asha Rao',
  employeeId: 'DBS1',
  shift: { name: 'Night', timezone: 'Asia/Kolkata', startTime: '21:00', endTime: '06:00' },
  weekOff: ['Sunday'],
  leavesAllowed: 12,
  holidays: [
    { title: 'Old', date: past(10), isActive: true },
    { title: 'Diwali', date: future(20), isActive: true },
    { title: 'Holi', date: future(5), isActive: true },
    { title: 'Retired', date: future(7), isActive: false },
  ],
};

describe('get_work_schedule', () => {
  it('self: shift, week-off and only upcoming ACTIVE assigned holidays, soonest first', async () => {
    const Employee = fakeModel(() => PROFILE);
    const res = await getWorkSchedule.execute({}, { user: perms(), deps: { Employee, Student: fakeModel(() => null) } });
    assert.deepEqual(Employee.calls[0], { owner: USER_ID });
    assert.equal(res.self, true);
    assert.equal(res.shift.name, 'Night');
    assert.deepEqual(res.weekOff, ['Sunday']);
    assert.deepEqual(res.upcomingHolidays.map((h) => h.title), ['Holi', 'Diwali']);
    assert.equal(res.leavesAllowed, 12);
  });

  it('self falls back to the Student profile', async () => {
    const Student = fakeModel(() => ({ ...PROFILE, fullName: undefined, owner: undefined }));
    const res = await getWorkSchedule.execute({}, { user: perms(), deps: { Employee: fakeModel(() => null), Student } });
    assert.deepEqual(Student.calls[0], { user: USER_ID });
    assert.equal(res.shift.startTime, '21:00');
  });

  it('another person needs an Employees-page permission (not a role name)', async () => {
    const res = await getWorkSchedule.execute({ person: 'Ravi' }, { user: perms(), deps: {} });
    assert.match(res.error, /own schedule/);
  });

  it('another person resolves through executeEmployeeQuery (row scope) and returns matches when ambiguous', async () => {
    const queries = [];
    const executeEmployeeQuery = async (q) => {
      queries.push(q);
      return { success: true, total: 2, records: [{ _id: 'a', fullName: 'Ravi A' }, { _id: 'b', fullName: 'Ravi B' }] };
    };
    const res = await getWorkSchedule.execute(
      { person: 'Ravi' },
      { user: perms('employees.read'), deps: { executeEmployeeQuery } },
    );
    assert.equal(queries[0].filters.search, 'Ravi');
    assert.equal(queries[0].filters.ownerUserRole, 'employee');
    assert.deepEqual(res.matches.map((m) => m.name), ['Ravi A', 'Ravi B']);
  });

  it('one match loads that Employee by id', async () => {
    const executeEmployeeQuery = async () => ({ success: true, total: 1, records: [{ _id: 'e9', fullName: 'Ravi' }] });
    const Employee = fakeModel(() => ({ ...PROFILE, owner: 'someone-else', fullName: 'Ravi' }));
    const res = await getWorkSchedule.execute(
      { person: 'Ravi' },
      { user: perms('employees.read'), deps: { executeEmployeeQuery, Employee } },
    );
    assert.deepEqual(Employee.calls[0], { _id: 'e9' });
    assert.equal(res.self, false);
    assert.equal(res.name, 'Ravi');
  });
});

describe('list_shifts', () => {
  const queryShifts = async () => ({
    totalResults: 2,
    results: [
      { _id: 's1', name: 'Day', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata', isActive: true },
      { _id: 's2', name: 'Night', startTime: '21:00', endTime: '06:00', timezone: 'Asia/Kolkata', isActive: true },
    ],
  });

  it('lists active shifts by default and declares a measure', async () => {
    let seen;
    const res = await listShifts.execute({}, {
      user: perms('students.read'),
      deps: { queryShifts: async (f, o) => { seen = f; return queryShifts(f, o); } },
    });
    assert.deepEqual(seen, { isActive: true });
    assert.equal(res.total, 2);
    assert.ok(listShifts.measure);
  });

  it('assignees need attendance.assign', async () => {
    const res = await listShifts.execute({ includeAssignees: true }, { user: perms('students.read'), deps: { queryShifts } });
    assert.match(res.assigneesHidden, /attendance\.assign/);
  });

  it('adds each shift roster with attendance.assign', async () => {
    const queryShiftAssignees = async (id) => ({
      totalResults: id === 's2' ? 1 : 0, people: id === 's2' ? [{ name: 'Asha', type: 'Employee' }] : [],
    });
    const res = await listShifts.execute(
      { includeAssignees: true },
      { user: perms('students.read', 'attendance.assign'), deps: { queryShifts, queryShiftAssignees } },
    );
    assert.equal(res.shifts[1].assigneeCount, 1);
    assert.equal(res.shifts[1].assignees[0].name, 'Asha');
  });
});

describe('list_holidays', () => {
  it('mine (default) = the viewer\'s ASSIGNED holidays, not every active Holiday (B4)', async () => {
    let companyCalled = false;
    const res = await listHolidays.execute({}, {
      user: perms(),
      deps: {
        Employee: fakeModel(() => PROFILE),
        Student: fakeModel(() => null),
        queryHolidays: async () => { companyCalled = true; return { results: [], totalResults: 0 }; },
      },
    });
    assert.equal(companyCalled, false);
    assert.equal(res.scope, 'mine');
    assert.deepEqual(res.holidays.map((h) => h.title), ['Holi', 'Diwali']);
    assert.equal(res.total, 2);
    assert.ok(listHolidays.measure);
  });

  it('window bounds use whole UTC days', async () => {
    const d = (n) => future(n).toISOString().slice(0, 10);
    const res = await listHolidays.execute({ window: { from: d(1), to: d(10) } }, {
      user: perms(), deps: { Employee: fakeModel(() => PROFILE), Student: fakeModel(() => null) },
    });
    assert.deepEqual(res.holidays.map((h) => h.title), ['Holi']);
  });

  it('rejects a malformed day', async () => {
    await assert.rejects(
      listHolidays.execute({ window: { from: '2026-13-45' } }, { user: perms(), deps: { Employee: fakeModel(() => PROFILE) } }),
      /Invalid date/,
    );
  });

  it('company scope needs students.read and reads the Holidays page service', async () => {
    const denied = await listHolidays.execute({ scope: 'company' }, { user: perms(), deps: {} });
    assert.match(denied.error, /students\.read/);
    let filter;
    const res = await listHolidays.execute({ scope: 'company' }, {
      user: perms('students.read'),
      deps: {
        queryHolidays: async (f) => { filter = f; return { totalResults: 1, results: [{ title: 'Diwali', date: future(20) }] }; },
      },
    });
    assert.equal(filter.isActive, true);
    assert.ok(filter.date.$gte instanceof Date);
    assert.equal(res.total, 1);
  });
});

describe('schedule / org matchesTurn', () => {
  it('matches schedule questions', () => {
    for (const q of ['what is my shift', 'when is my next holiday', 'what is my week off', 'who works the night shift']) {
      assert.equal(matchesTurn(q), true, q);
    }
  });

  it('does not steal attendance/leave, task/project or meeting turns', () => {
    for (const q of [
      'show my attendance for the night shift', 'who is on leave on the holiday', 'tasks due before the holiday',
      'meetings during my shift', 'how many projects does the Sales department have',
      'list tasks for managers', 'which meetings did the manager attend', 'my leave balance',
    ]) {
      assert.equal(matchesTurn(q) || orgMatchesTurn(q), false, q);
    }
  });

  it('org matches manager / department / org chart turns, incl. project managers', () => {
    for (const q of ['how many managers do we have', 'list departments', 'who is in Group A', 'how many project managers']) {
      assert.equal(orgMatchesTurn(q), true, q);
    }
    assert.equal(orgMatchesTurn('count employees group by designation'), false);
  });
});
