import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countUsers from '../countUsers.tool.js';
import listUsers from '../listUsers.tool.js';
import getUser from '../getUser.tool.js';
import listRoles from '../listRoles.tool.js';
import getRole from '../getRole.tool.js';
import peopleDomain, { matchesTurn } from '../index.js';
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
  const tools = [countUsers, listUsers, getUser, listRoles, getRole];

  it('every tool was built by defineTool with a JSON schema', () => {
    for (const tool of tools) {
      assert.equal(tool.domain, 'people');
      assert.equal(tool.kind, 'read');
      assert.equal(tool.jsonSchema.type, 'object');
    }
    assert.deepEqual(tools.map((t) => t.name), ['count_users', 'list_users', 'get_user', 'list_roles', 'get_role']);
  });

  it('index.js default export matches the domain module shape, including the new matchesTurn gate interface', () => {
    assert.equal(peopleDomain.domain, 'people');
    assert.equal(typeof peopleDomain.instructions, 'string');
    assert.ok(peopleDomain.instructions.length > 0);
    assert.deepEqual(peopleDomain.tools, tools);
    assert.equal(typeof peopleDomain.matchesTurn, 'function');
  });

  it('is registered in agent/tools/index.js', () => {
    assert.ok(allDomains.includes(peopleDomain));
  });

  it('matchesTurn is true for user/role/who-is/headcount/capability turns and false for unrelated or other-domain ones (review fix round 1, I-4)', () => {
    for (const text of [
      'how many users do we have',
      'list all user accounts',
      'who has the recruiter role',
      'how many admins are there',
      'who is Priya Sharma',
      'Who is Priya Sharma?', // sentence-start capital "Who" must also match
      'what roles exist',
      'what permissions does Sales Agent have',
      'what can a sales agent do', // the brief's own get_role routing example
      'what can an administrator do',
      'what are the permissions for the recruiter role', // "permissions of/for <X>"
    ]) {
      assert.ok(matchesTurn(text), `expected matchesTurn to be true for: ${text}`);
    }
    for (const text of [
      'how many jobs are open',
      'list active job postings',
      'who is on leave today',
      'Who is on leave today?',
      "show me today's attendance summary",
      'how many users logged in today', // login-activity report, not a headcount
      'show login history for Rahul', // ditto
      'how many candidates are assigned to agent Rahul', // Employees/Candidates agent-assignment flow
      'permission to take leave', // everyday phrasing, not RBAC
      'my account settings', // everyday phrasing, not a user-directory lookup
      '',
    ]) {
      assert.equal(matchesTurn(text), false, `expected matchesTurn to be false for: ${text}`);
    }
  });

  it('matchesTurn opens on a role noun that is the object of a list/count verb (round 2: no legacy role fast path)', () => {
    for (const text of [
      'list all recruiters',
      'list recruiters',
      'show me agents',
      'show me all the sales agents',
      'who are the admins',
      'list all administrators',
      'how many students do we have',
      'count the students',
      'how many agents',
    ]) {
      assert.ok(matchesTurn(text), `expected matchesTurn to be true for: ${text}`);
    }
    for (const text of [
      'how many candidates are assigned to agent Rahul', // agent-assignment flow, "agent" is not the verb's object
      'show candidates assigned to agent Rahul',
      'how many students completed the course', // training analytics
      'list students enrolled in React basics',
      'agent performance this week', // no list/count verb
    ]) {
      assert.equal(matchesTurn(text), false, `expected matchesTurn to be false for: ${text}`);
    }
  });
});
