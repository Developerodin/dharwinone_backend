import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countUsers from '../countUsers.tool.js';
import listUsers from '../listUsers.tool.js';
import getUser from '../getUser.tool.js';
import getMyProfile from '../getMyProfile.tool.js';
import whatCanIDo from '../whatCanIDo.tool.js';
import listRoles from '../listRoles.tool.js';
import getRole from '../getRole.tool.js';
import peopleDomain from '../index.js';
import allDomains from '../../index.js';
import { ROLES_ACCESS } from '../common.js';

/** Chainable query stub: every method returns itself except the terminal lean(). */
function chainable(result) {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    populate: () => q,
    lean: async () => result,
  };
  return q;
}

function fakeUser({ aggregateResults = [], aggregateFn } = {}) {
  const calls = { aggregate: [] };
  const User = {
    aggregate: async (pipeline) => {
      calls.aggregate.push(pipeline);
      return aggregateFn ? aggregateFn(pipeline) : aggregateResults;
    },
  };
  return { User, calls };
}

/** `.find()` honors a `{_id:{$in:[...]}}` filter; otherwise returns every doc. */
function fakeRole(docs = []) {
  const calls = { find: [], findById: [] };
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const Role = {
    find: (filter = {}, projection) => {
      calls.find.push({ filter, projection });
      const ids = filter?._id?.$in;
      const matched = ids ? docs.filter((d) => ids.map(String).includes(String(d._id))) : docs;
      return chainable(matched);
    },
    findById: (id) => {
      calls.findById.push(id);
      return chainable(byId.get(String(id)) ?? null);
    },
  };
  return { Role, calls };
}

const VIEWER = { id: 'viewer-1', roleIds: [] };

function ctxFor(overrides = {}) {
  return {
    user: VIEWER,
    requestId: 'req-1',
    deps: {
      User: fakeUser().User,
      Role: fakeRole().Role,
      viewerSeesHiddenUsers: () => false,
      getDirectoryHiddenUserIds: async () => [],
      queryRoles: async () => ({ results: [] }),
      ...overrides,
    },
  };
}

describe('list_roles', () => {
  it('computes userCount via a fresh active/hidden/platform-super-scoped aggregate (Ruling R9), not queryRoles\' own counts', async () => {
    const { User, calls } = fakeUser({ aggregateResults: [{ _id: 'r1', count: 3 }] });
    const ctx = ctxFor({
      User,
      queryRoles: async () => ({
        results: [{ id: 'r1', name: 'Recruiter', aliases: ['Recruiters'], status: 'active', assigneeCountTotal: 999 }],
      }),
      viewerSeesHiddenUsers: () => false,
      getDirectoryHiddenUserIds: async () => ['hidden-1'],
    });
    const out = await listRoles.execute({}, ctx);
    assert.deepEqual(out.roles, [{ id: 'r1', name: 'Recruiter', aliases: ['Recruiters'], status: 'active', userCount: 3 }]);
    const $match = calls.aggregate[0][0].$match;
    assert.equal($match.status, 'active');
    assert.equal($match.platformSuperUser.$ne, true);
    assert.deepEqual($match._id.$nin, ['hidden-1']);
  });

  it('skips the hidden-user lookup for a platform-super viewer', async () => {
    let hiddenCalled = false;
    const { User } = fakeUser({ aggregateResults: [] });
    const ctx = ctxFor({
      User,
      queryRoles: async () => ({ results: [] }),
      viewerSeesHiddenUsers: () => true,
      getDirectoryHiddenUserIds: async () => {
        hiddenCalled = true;
        return [];
      },
    });
    await listRoles.execute({}, ctx);
    assert.equal(hiddenCalled, false);
  });

  it('has roles.read access', () => {
    assert.deepEqual(listRoles.access, ROLES_ACCESS);
  });

  it('renders a roles table with no count facts', () => {
    const out = listRoles.render({ roles: [{ name: 'Recruiter', aliases: [], status: 'active', userCount: 3 }] });
    assert.equal(out.blocks[0].type, 'table');
    assert.deepEqual(out.facts.counts, []);
  });
});

describe('get_role', () => {
  it('returns matches:[] for zero matches', async () => {
    const { Role } = fakeRole([]);
    assert.deepEqual(await getRole.execute({ name: 'Wizard' }, ctxFor({ Role })), { matches: [] });
  });

  it('returns matches for a name that resolves to more than one role', async () => {
    const { Role } = fakeRole([
      { _id: 'r1', name: 'agent', slug: 'agent', aliases: [], previousNames: [], status: 'active' },
      { _id: 'r2', name: 'Agent', slug: 'agent2', aliases: ['agent'], previousNames: [], status: 'active' },
    ]);
    const out = await getRole.execute({ name: 'agent' }, ctxFor({ Role }));
    assert.equal(out.matches.length, 2);
  });

  it('resolves by name, slug, alias, or a previous name and returns the full definition', async () => {
    const { Role } = fakeRole([{
      _id: 'r1', name: 'Sales Agent', slug: 'salesagent', aliases: ['SalesAgent'],
      previousNames: [{ name: 'Old Sales' }], status: 'active', permissions: ['candidates.read'],
    }]);
    const out = await getRole.execute({ name: 'Old Sales' }, ctxFor({ Role }));
    assert.deepEqual(out, {
      name: 'Sales Agent', slug: 'salesagent', aliases: ['SalesAgent'], status: 'active', permissions: ['candidates.read'],
    });
  });

  it('has roles.read access', () => {
    assert.deepEqual(getRole.access, ROLES_ACCESS);
  });

  it('renders a kv block with no count facts, and nothing for matches', () => {
    const out = getRole.render({ name: 'Sales Agent', aliases: [], status: 'active', permissions: ['x'] });
    assert.equal(out.blocks[0].type, 'kv');
    assert.deepEqual(out.facts.counts, []);
    assert.equal(getRole.render({ matches: [] }), null);
  });
});

describe('people domain module', () => {
  const tools = [countUsers, listUsers, getUser, getMyProfile, whatCanIDo, listRoles, getRole];

  it('every tool was built by defineTool with a JSON schema', () => {
    for (const tool of tools) {
      assert.equal(tool.domain, 'people');
      assert.equal(tool.kind, 'read');
      assert.equal(tool.jsonSchema.type, 'object');
    }
    assert.deepEqual(tools.map((t) => t.name), ['count_users', 'list_users', 'get_user', 'get_my_profile', 'what_can_i_do', 'list_roles', 'get_role']);
  });

  it('index.js default export matches the domain module shape', () => {
    assert.equal(peopleDomain.domain, 'people');
    assert.equal(typeof peopleDomain.instructions, 'string');
    assert.ok(peopleDomain.instructions.length > 0);
    assert.deepEqual(peopleDomain.tools, tools);
  });

  it('is registered in agent/tools/index.js', () => {
    assert.ok(allDomains.includes(peopleDomain));
  });
});
