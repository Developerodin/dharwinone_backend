import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_ACCESS, checkToolAccess, applyRowScope, resolveRowScope, redactSalary } from '../toolAccess.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const svcSrc = fs.readFileSync(path.join(here, '..', '..', 'chatAssistant.service.js'), 'utf8');

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });
const notAdmin = { isAdmin: async () => false };
const admin = { isAdmin: async () => true };

describe('toolAccess', () => {
  it('every ROUTING_TOOLS name has a TOOL_ACCESS entry', () => {
    const start = svcSrc.indexOf('const ROUTING_TOOLS = [');
    const end = svcSrc.indexOf('\n];', start);
    const names = [...svcSrc.slice(start, end).matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 39, `parsed ${names.length} tool names`);
    const missing = names.filter((n) => !(n in TOOL_ACCESS));
    assert.deepEqual(missing, []);
  });

  it('denies unknown tools', async () => {
    const r = await checkToolAccess('fetch_everything', userWith('candidates.read'), notAdmin);
    assert.equal(r.ok, false);
  });

  it('denies fetch_candidates to a user with no candidate/employee read', async () => {
    const r = await checkToolAccess('fetch_candidates', userWith('tasks.read'), notAdmin);
    assert.equal(r.ok, false);
    assert.match(r.reason, /candidates/i);
  });

  it('allows fetch_candidates with candidates.read', async () => {
    const r = await checkToolAccess('fetch_candidates', userWith('candidates.read'), notAdmin);
    assert.equal(r.ok, true);
  });

  it('denies fetch_offers to a Candidate-role user', async () => {
    const r = await checkToolAccess('fetch_offers', userWith('jobs.read'), notAdmin);
    assert.equal(r.ok, false);
  });

  it('allows fetch_offers with pre-boarding.read (route parity)', async () => {
    const r = await checkToolAccess('fetch_offers', userWith('pre-boarding.read'), notAdmin);
    assert.equal(r.ok, true);
  });

  it('platformSuperUser passes with no permissions', async () => {
    const su = { ...userWith(), platformSuperUser: true };
    assert.equal((await checkToolAccess('fetch_roles', su, notAdmin)).ok, true);
  });

  it('denies a user with no matching permission even if a hypothetical isAdmin would say true (no admin shortcut)', async () => {
    const r = await checkToolAccess('fetch_roles', userWith(), admin);
    assert.equal(r.ok, false);
  });

  it('self-scoped tools pass with no permissions', async () => {
    assert.equal((await checkToolAccess('fetch_current_user', userWith(), notAdmin)).ok, true);
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
