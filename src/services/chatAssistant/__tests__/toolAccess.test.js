import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAccessRule,
  applyRowScope,
  resolveRowScope,
  redactSalary,
  rowMatchesAllowed,
  canReadOtherTraining,
} from '../toolAccess.js';

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });
const notAdmin = { isAdmin: async () => false };
const admin = { isAdmin: async () => true };
const PEOPLE_RULE = { anyOf: ['candidates.read', 'employees.read'], rowScope: 'person' };

describe('checkAccessRule', () => {
  it('a rule with no anyOf (a { note } rule) passes every user', async () => {
    assert.equal((await checkAccessRule({ note: 'self only' }, userWith(), notAdmin)).ok, true);
  });

  it('denies a user with none of the anyOf permissions, naming them', async () => {
    const r = await checkAccessRule(PEOPLE_RULE, userWith('tasks.read'), notAdmin);
    assert.equal(r.ok, false);
    assert.match(r.reason, /candidates/i);
  });

  it('allows a user with one of the anyOf permissions', async () => {
    assert.equal((await checkAccessRule(PEOPLE_RULE, userWith('candidates.read'), notAdmin)).ok, true);
  });

  it('platformSuperUser passes with no permissions', async () => {
    const su = { ...userWith(), platformSuperUser: true };
    assert.equal((await checkAccessRule({ anyOf: ['jobs.read'] }, su, notAdmin)).ok, true);
  });

  it('no admin shortcut: an admin without the permission is denied', async () => {
    assert.equal((await checkAccessRule({ anyOf: ['jobs.read'] }, userWith(), admin)).ok, false);
  });

  it('adminByName lets an Administrator-by-name user through, and only then', async () => {
    const rule = { anyOf: ['jobs.read'], adminByName: true };
    assert.equal((await checkAccessRule(rule, userWith(), admin)).ok, true);
    assert.equal((await checkAccessRule(rule, userWith(), notAdmin)).ok, false);
  });

  it('allOf is AND: one permission of two is denied, naming the list; both pass', async () => {
    const rule = { allOf: ['candidates.manage', 'jobs.manage'] };
    const one = await checkAccessRule(rule, userWith('candidates.manage'), notAdmin);
    assert.equal(one.ok, false);
    assert.equal(one.reason, 'Requires all of: candidates.manage, jobs.manage.');
    assert.equal((await checkAccessRule(rule, userWith('candidates.manage', 'jobs.manage'), notAdmin)).ok, true);
  });

  it('allOf resolves aliases per permission, like anyOf', async () => {
    // activity.read grants activityLogs.read (config/permissions.js permissionAliases).
    const rule = { allOf: ['activityLogs.read', 'jobs.read'] };
    assert.equal((await checkAccessRule(rule, userWith('activity.read', 'jobs.read'), notAdmin)).ok, true);
    assert.equal((await checkAccessRule(rule, userWith('activity.read'), notAdmin)).ok, false);
  });

  it('anyOf and allOf together: both must hold', async () => {
    const rule = { anyOf: ['jobs.read', 'jobs.manage'], allOf: ['candidates.manage'] };
    assert.equal((await checkAccessRule(rule, userWith('jobs.read', 'candidates.manage'), notAdmin)).ok, true);
    assert.equal((await checkAccessRule(rule, userWith('jobs.read'), notAdmin)).ok, false);
    const neither = await checkAccessRule(rule, userWith('candidates.manage'), notAdmin);
    assert.equal(neither.ok, false);
    assert.equal(neither.reason, 'Requires one of: jobs.read, jobs.manage.');
  });

  it('platformSuperUser passes an allOf rule with no permissions', async () => {
    const su = { ...userWith(), platformSuperUser: true };
    assert.equal((await checkAccessRule({ allOf: ['a.manage', 'b.manage'] }, su, notAdmin)).ok, true);
  });
});

describe('training person gate', () => {
  it('denies reading another person without students.read', async () => {
    assert.equal(await canReadOtherTraining(userWith('tasks.read')), false);
  });

  it('allows with students.read', async () => {
    assert.equal(await canReadOtherTraining(userWith('students.read')), true);
  });

  it('platformSuperUser passes with no permissions', async () => {
    const su = { ...userWith(), platformSuperUser: true };
    assert.equal(await canReadOtherTraining(su), true);
  });
});

describe('row scope', () => {
  it('null scope leaves result untouched', () => {
    const r = { total: 99, baseTotal: 99, breakdown: { a: 1 }, records: [{ _id: 'x' }] };
    assert.deepEqual(applyRowScope(r, null), r);
  });

  it('filters records by _id / owner and rewrites counts', () => {
    const r = {
      total: 50, baseTotal: 50, breakdown: { Active: 50 },
      records: [{ _id: 'a' }, { _id: 'b' }, { owner: 'c' }, { owner: { _id: 'd' } }],
    };
    const out = applyRowScope(r, new Set(['a', 'd']));
    assert.deepEqual(out.records.map((x) => x._id || x.owner._id), ['a', 'd']);
    assert.equal(out.total, 2);
    assert.equal(out.baseTotal, 2);
    assert.equal(out.breakdown, undefined);
    assert.equal(out.scopedToYou, true);
  });

  it('filters a bare-array result (semantic_employee_search shape)', () => {
    const r = [{ _id: 'a' }, { _id: 'b' }];
    assert.deepEqual(applyRowScope(r, new Set(['a'])), [{ _id: 'a' }]);
  });

  it('filters a { candidates } result (match_candidates_to_job shape), dropping non-matching rows', () => {
    const r = { job: 'Engineer', candidates: [{ userId: 'a', name: 'A' }, { userId: 'z', name: 'Z' }] };
    const out = applyRowScope(r, new Set(['a']));
    assert.deepEqual(out.candidates, [{ userId: 'a', name: 'A' }]);
    assert.equal(out.job, 'Engineer');
    assert.equal(out.scopedToYou, true);
  });

  it('strips company-wide aggregates and pre-rendered rosters, and cuts page.total to the filtered count', () => {
    const r = {
      total: 500, baseTotal: 500,
      employmentBreakdown: { active: 480, resigned: 20, total: 500 },
      rendered: '### 500 employees\n...(full unscoped markdown roster)...',
      page: { from: 1, to: 500, total: 500, hasMore: true, nextCursor: { lastId: 'z' } },
      records: [{ _id: 'a' }, { _id: 'b' }, { _id: 'z' }],
    };
    const out = applyRowScope(r, new Set(['a', 'b']));
    assert.deepEqual(out.records.map((x) => x._id), ['a', 'b']);
    assert.equal(out.employmentBreakdown, undefined);
    assert.equal(out.rendered, undefined);
    assert.equal(out.page.total, 2);
    assert.equal(out.page.hasMore, false);
    assert.equal(out.total, 2);
    assert.equal(out.baseTotal, 2);
    assert.equal(out.scopedToYou, true);
  });

  it('cuts page.total on a { candidates } result too', () => {
    const r = {
      job: 'Engineer',
      page: { total: 10, hasMore: true },
      candidates: [{ userId: 'a' }, { userId: 'z' }],
    };
    const out = applyRowScope(r, new Set(['a']));
    assert.deepEqual(out.candidates, [{ userId: 'a' }]);
    assert.equal(out.page.total, 1);
    assert.equal(out.page.hasMore, false);
  });

  it('rowMatchesAllowed matches on _id/id/userId/owner', () => {
    const allowed = new Set(['a']);
    assert.equal(rowMatchesAllowed({ _id: 'a' }, allowed), true);
    assert.equal(rowMatchesAllowed({ id: 'a' }, allowed), true);
    assert.equal(rowMatchesAllowed({ userId: 'a' }, allowed), true);
    assert.equal(rowMatchesAllowed({ owner: 'a' }, allowed), true);
    assert.equal(rowMatchesAllowed({ owner: { _id: 'a' } }, allowed), true);
    assert.equal(rowMatchesAllowed({ _id: 'z' }, allowed), false);
  });

  it('sales agent scope resolves to referred/assigned owners', async () => {
    const deps = {
      applyScope: async () => ({ salesAgentScopeUserId: 'sa1' }),
      distinctOwners: async (q) => {
        assert.deepEqual(q, { $or: [{ referredByUserId: 'sa1' }, { currentSalesAgentUserId: 'sa1' }] });
        return ['o1', 'o2'];
      },
    };
    const s = await resolveRowScope({ id: 'sa1' }, deps);
    assert.deepEqual([...s].sort(), ['o1', 'o2']);
  });

  it('agent scope resolves to assignedAgent owners', async () => {
    const deps = {
      applyScope: async () => ({ agentIds: 'ag1' }),
      distinctOwners: async (q) => {
        assert.deepEqual(q, { assignedAgent: 'ag1' });
        return ['o9'];
      },
    };
    assert.deepEqual([...(await resolveRowScope({ id: 'ag1' }, deps))], ['o9']);
  });

  it('self scope resolves to the user only', async () => {
    const deps = { applyScope: async () => ({ owner: 'me' }), distinctOwners: async () => [] };
    assert.deepEqual([...(await resolveRowScope({ id: 'me' }, deps))], ['me']);
  });

  it('admin / full-crud scope is unrestricted', async () => {
    const deps = { applyScope: async () => ({}), distinctOwners: async () => [] };
    assert.equal(await resolveRowScope({ id: 'x' }, deps), null);
  });
});

describe('salary redaction', () => {
  const r = () => ({ records: [{ _id: 'a', salaryRange: { min: 1 }, nested: { salaryRange: 2 } }] });

  it('strips salaryRange without employees.manage', async () => {
    const out = await redactSalary(r(), userWith('employees.read'));
    assert.equal(out.records[0].salaryRange, undefined);
    assert.equal(out.records[0].nested.salaryRange, undefined);
  });

  it('keeps salaryRange with employees.manage', async () => {
    const out = await redactSalary(r(), userWith('employees.manage'));
    assert.deepEqual(out.records[0].salaryRange, { min: 1 });
  });

  it('platformSuperUser keeps salaryRange with no permissions', async () => {
    const su = { ...userWith(), platformSuperUser: true };
    const out = await redactSalary(r(), su);
    assert.deepEqual(out.records[0].salaryRange, { min: 1 });
  });
});
