import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import findDuplicatePeople, { duplicatePipeline } from '../findDuplicatePeople.tool.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });

const facet = (total, groups) => [{ total: total ? [{ n: total }] : [], groups }];
const group = (value, size, names) => ({
  _id: value, size, people: names.map((name, i) => ({ id: `e${value}${i}`, name, userId: `u${value}${i}` })),
});

/** Fake Employees-page scope + aggregate; records every call. */
function harness({ email = facet(0, []), phone = facet(0, []) } = {}) {
  const seen = { scope: [], built: [], cast: [], pipelines: [] };
  const deps = {
    applyEmployeeListScope: async (apiFilter, user) => {
      seen.scope.push({ apiFilter, userId: user.id });
      return { ...apiFilter, salesAgentScopeUserId: 'scoped' };
    },
    buildEmployeeListMongoFilter: async (apiFilter) => {
      seen.built.push(apiFilter);
      return { mongoFilter: { owner: { $in: ['64b7f0c2a1b2c3d4e5f60718'] }, scopedBy: apiFilter.salesAgentScopeUserId } };
    },
    castFilter: (f) => {
      seen.cast.push(f);
      return { ...f, cast: true };
    },
    Employee: {
      aggregate: async (pipeline) => {
        seen.pipelines.push(pipeline);
        const field = pipeline[1].$project.key.$toLower ? 'email' : 'phone';
        return field === 'email' ? email : phone;
      },
    },
  };
  return { ctx: { user: userWith('employees.read'), deps }, seen };
}

const exec = (args, h) => findDuplicatePeople.execute(findDuplicatePeople.input.validate(args).value, h.ctx);

describe('find_duplicate_people — definition and access', () => {
  it('is a person-domain read tool gated by the Employees / Candidates page read permissions', () => {
    assert.equal(findDuplicatePeople.name, 'find_duplicate_people');
    assert.equal(findDuplicatePeople.domain, 'person');
    assert.equal(findDuplicatePeople.kind, 'read');
    assert.deepEqual([...findDuplicatePeople.access.anyOf].sort(), ['candidates.manage', 'candidates.read', 'employees.manage', 'employees.read']);
  });

  it('access denied without any of those permissions; allowed with candidates.read', async () => {
    assert.equal((await checkAccessRule(findDuplicatePeople.access, userWith('users.read'))).ok, false);
    assert.equal((await checkAccessRule(findDuplicatePeople.access, userWith('candidates.read'))).ok, true);
  });

  it('input defaults: both fields, all people, 5 groups; limit capped at 50', () => {
    assert.deepEqual(findDuplicatePeople.input.validate({}).value, { by: 'both', population: 'all', limit: 5 });
    assert.ok(findDuplicatePeople.input.validate({ limit: 51 }).error);
    assert.ok(findDuplicatePeople.input.validate({ by: 'name' }).error);
  });

  it('throws without an authenticated user (fail closed)', async () => {
    await assert.rejects(findDuplicatePeople.execute({}, { deps: {} }), /authenticated user/);
  });
});

describe('find_duplicate_people — scope', () => {
  it('population maps to the Employees page role filter, every employment status, through the page scope', async () => {
    for (const [population, ownerUserRole] of [['candidates', 'candidate'], ['employees', 'employee'], ['all', 'jobSeeker']]) {
      const h = harness();
      await exec({ population, by: 'email' }, h);
      assert.deepEqual(h.seen.scope[0], { apiFilter: { ownerUserRole, employmentStatus: 'all' }, userId: 'u1' });
      assert.equal(h.seen.built[0].salesAgentScopeUserId, 'scoped', 'row scope applied before building the filter');
      // The scoped, cast filter is the aggregate's first stage.
      assert.deepEqual(h.seen.pipelines[0][0], { $match: { owner: { $in: ['64b7f0c2a1b2c3d4e5f60718'] }, scopedBy: 'scoped', cast: true } });
    }
  });

  it('by both runs one aggregate per field over the same scoped filter', async () => {
    const h = harness();
    await exec({}, h);
    assert.equal(h.seen.pipelines.length, 2);
    assert.equal(h.seen.cast.length, 1);
  });
});

describe('find_duplicate_people — pipeline', () => {
  it('groups by the normalised key, keeps groups of 2+, largest first, at most 5 people each', () => {
    const p = duplicatePipeline({ x: 1 }, 'email', 7);
    assert.deepEqual(p[0], { $match: { x: 1 } });
    assert.ok(p[1].$project.key.$toLower.$trim, 'email key is lower-cased and trimmed');
    assert.deepEqual(p[2], { $match: { key: { $nin: ['', null] } } });
    assert.equal(p[3].$group._id, '$key');
    assert.deepEqual(p[4], { $match: { size: { $gt: 1 } } });
    assert.deepEqual(p[5], { $sort: { size: -1, _id: 1 } });
    assert.deepEqual(p[6].$facet.total, [{ $count: 'n' }]);
    assert.deepEqual(p[6].$facet.groups[0], { $limit: 7 });
    assert.deepEqual(p[6].$facet.groups[1].$project.people, { $slice: ['$people', 5] });
  });

  it('phone key is digits only, last 10, and blank for placeholders under 7 digits', () => {
    const key = duplicatePipeline({}, 'phone', 5)[1].$project.key.$let;
    assert.equal(key.vars.d.$reduce.input.$regexFindAll.regex, '[0-9]');
    const [cond, lastTen, blank] = key.in.$cond;
    assert.deepEqual(cond, { $gte: [{ $strLenCP: '$$d' }, 7] });
    assert.equal(lastTen.$substrCP[2], 10);
    assert.equal(blank, '');
  });
});

describe('find_duplicate_people — results', () => {
  it('merges email and phone groups, largest first, with the full group count per field', async () => {
    const h = harness({
      email: facet(1, [group('a@x.com', 2, ['Asha Rao', 'Asha  Rao'])]),
      phone: facet(3, [group('9876543210', 3, ['Ravi', 'Ravi K', 'R Kumar']), group('9123456789', 2, ['Neha', 'Neha S'])]),
    });
    const r = await exec({ limit: 2 }, h);
    assert.equal(r.totalGroups, 4);
    assert.deepEqual(r.byField, { email: 1, phone: 3 });
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups.map((g) => [g.matchedOn, g.value, g.size]), [['phone', '9876543210', 3], ['email', 'a@x.com', 2]]);
    assert.deepEqual(r.groups[0].people[0], { id: 'e98765432100', name: 'Ravi', userId: 'u98765432100' });
    assert.equal(r.truncated, true);
    assert.match(r.emailNote, /unique/);
  });

  it('no duplicates → zero groups, not truncated; phone-only has no email note', async () => {
    const r = await exec({ by: 'phone' }, harness());
    assert.deepEqual(r, { by: 'phone', population: 'all', totalGroups: 0, byField: { phone: 0 }, groups: [] });
  });

  it('a group larger than 5 shows its full size and at most the 5 people the pipeline kept', async () => {
    const big = { _id: '9999999999', size: 12, people: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, name: `P${i}`, userId: null })) };
    const r = await exec({ by: 'phone' }, harness({ phone: facet(1, [big]) }));
    assert.equal(r.groups[0].size, 12);
    assert.equal(r.groups[0].people.length, 5);
    assert.equal(r.groups[0].people[0].userId, null);
  });

  it('render: one row per group and a duplicate-groups count fact', async () => {
    const r = await exec({ by: 'email' }, harness({ email: facet(1, [group('a@x.com', 2, ['Asha Rao', 'Asha R'])]) }));
    const out = findDuplicatePeople.render(r);
    assert.equal(out.blocks[0].tableType, 'duplicate-people');
    assert.deepEqual(out.blocks[0].rows[0], { matchedOn: 'email', value: 'a@x.com', size: '2', people: 'Asha Rao, Asha R' });
    assert.deepEqual(out.facts.counts[0], { kind: 'find_duplicate_people', label: 'duplicate groups', total: 1 });
    assert.deepEqual(findDuplicatePeople.render({ ...r, totalGroups: 0, groups: [] }).blocks, []);
  });
});
