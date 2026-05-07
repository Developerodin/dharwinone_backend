// uat.dharwin.backend/src/services/chatAssistant/__tests__/roleResolver.test.js
//
// Registry-backed shim. Aliases live on the Role document itself, so the mock
// returns docs with `slug`, `aliases`, and `previousNames` — same shape as the
// real schema. The shim's RoleModel parameter forces a fresh registry load.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleIds, tagRoleNames, canonicalize, ALIAS_GROUPS } from '../roleResolver.js';

function mockRoleModel(docs) {
  return {
    find: () => ({
      lean: async () => docs.filter((d) => d.status === 'active' || d.status === undefined),
    }),
  };
}

const docsFixture = [
  { _id: 'r-emp', name: 'Employee',      slug: 'employee',      aliases: ['employees'],                previousNames: [], status: 'active' },
  { _id: 'r-cnd', name: 'Candidate',     slug: 'candidate',     aliases: ['applicant', 'applicants'],  previousNames: [], status: 'active' },
  { _id: 'r-ag',  name: 'Agent',         slug: 'agent',         aliases: [],                            previousNames: [], status: 'active' },
  { _id: 'r-ag2', name: 'agent',         slug: undefined,       aliases: [],                            previousNames: [], status: 'active' },
  { _id: 'r-sa',  name: 'SalesAgent',    slug: 'salesagent',    aliases: ['sales agent', 'sales_agent'], previousNames: [], status: 'active' },
  { _id: 'r-rec', name: 'Recruiter',     slug: 'recruiter',     aliases: [],                            previousNames: [], status: 'active' },
  { _id: 'r-adm', name: 'Administrator', slug: 'administrator', aliases: ['admin', 'admins'],           previousNames: [], status: 'active' },
  { _id: 'r-stu', name: 'Student',       slug: 'student',       aliases: [],                            previousNames: [], status: 'active' },
];

describe('canonicalize (registry-backed, async)', () => {
  it('null/empty unchanged', async () => {
    assert.equal(await canonicalize(null), null);
    assert.equal(await canonicalize(''), '');
  });
});

describe('resolveRoleIds', () => {
  it('Employee resolves to the Employee Role doc only (Candidate is separate)', async () => {
    const Role = mockRoleModel(docsFixture);
    const out = await resolveRoleIds('Employee', Role);
    assert.deepEqual(out.ids, ['r-emp']);
    assert.deepEqual(out.names, ['Employee']);
  });

  it('agent input picks up both Agent docs (legacy duplicate)', async () => {
    const Role = mockRoleModel(docsFixture);
    const out = await resolveRoleIds('agent', Role);
    assert.deepEqual(out.ids.sort(), ['r-ag', 'r-ag2'].sort());
  });

  it('alias "admin" resolves to Administrator', async () => {
    const Role = mockRoleModel(docsFixture);
    const out = await resolveRoleIds('admin', Role);
    assert.deepEqual(out.ids, ['r-adm']);
    assert.deepEqual(out.names, ['Administrator']);
  });

  it('alias "applicant" resolves to Candidate', async () => {
    const Role = mockRoleModel(docsFixture);
    const out = await resolveRoleIds('applicant', Role);
    assert.deepEqual(out.ids, ['r-cnd']);
  });

  it('UnknownRole returns empty', async () => {
    const Role = mockRoleModel(docsFixture);
    const out = await resolveRoleIds('UnknownRole', Role);
    assert.deepEqual(out, { ids: [], names: [] });
  });

  it('null/empty input returns empty', async () => {
    const Role = mockRoleModel(docsFixture);
    assert.deepEqual(await resolveRoleIds(null, Role), { ids: [], names: [] });
    assert.deepEqual(await resolveRoleIds('', Role), { ids: [], names: [] });
  });
});

describe('tagRoleNames', () => {
  it('returns display-name Map for given roleIds', async () => {
    const Role = mockRoleModel(docsFixture);
    const map = await tagRoleNames(['r-emp', 'r-ag2'], Role);
    assert.equal(map.get('r-emp'), 'Employee');
    assert.equal(map.get('r-ag2'), 'agent');
  });

  it('returns empty Map when input empty/null', async () => {
    const Role = mockRoleModel(docsFixture);
    assert.equal((await tagRoleNames([], Role)).size, 0);
    assert.equal((await tagRoleNames(null, Role)).size, 0);
  });

  it('omits missing role ids without throwing', async () => {
    const Role = mockRoleModel(docsFixture);
    const map = await tagRoleNames(['r-emp', 'r-deleted'], Role);
    assert.equal(map.size, 1);
    assert.equal(map.get('r-emp'), 'Employee');
  });

  it('rejects non-array input gracefully', async () => {
    const Role = mockRoleModel(docsFixture);
    assert.equal((await tagRoleNames('not-array', Role)).size, 0);
    assert.equal((await tagRoleNames({}, Role)).size, 0);
    assert.equal((await tagRoleNames(0, Role)).size, 0);
  });
});

describe('ALIAS_GROUPS (deprecated legacy export)', () => {
  it('still exposes the legacy map for backward compatibility', () => {
    assert.ok(ALIAS_GROUPS.Employee);
    assert.ok(ALIAS_GROUPS.Agent);
    assert.ok(ALIAS_GROUPS.Administrator);
  });
});
