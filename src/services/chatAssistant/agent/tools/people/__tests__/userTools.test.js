import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countUsers from '../countUsers.tool.js';
import listUsers from '../listUsers.tool.js';
import getUser from '../getUser.tool.js';
import { buildUserMongoFilter, PEOPLE_ACCESS, PEOPLE_PROFILE_ACCESS } from '../common.js';
import { tagRoleSlugs, bustRoleRegistry } from '../../../../roleRegistry.js';
import { selectProviders } from '../../../../personProfile/selectProviders.js';

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

function fakeUser({ count = 0, docs = [], aggregateResults = [], countFn, aggregateFn } = {}) {
  const calls = { countDocuments: [], find: [], findById: [], aggregate: [], limit: [] };
  const User = {
    countDocuments: async (filter) => {
      calls.countDocuments.push(filter);
      return countFn ? countFn(filter) : count;
    },
    find: (filter) => {
      calls.find.push(filter);
      const q = chainable(docs);
      q.limit = (n) => {
        calls.limit.push(n);
        return q;
      };
      return q;
    },
    findById: () => chainable(null),
    aggregate: async (pipeline) => {
      calls.aggregate.push(pipeline);
      return aggregateFn ? aggregateFn(pipeline) : aggregateResults;
    },
  };
  return { User, calls };
}

/** `.find()` honors a `{_id:{$in:[...]}}` filter (roleNamesForIds/loadRoleDefs); otherwise returns every doc (resolveRoleNames' `Role.find({}, {...})`). */
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
      buildUserListMongoFilter: async (filter) => ({ ...filter }),
      getUserByIdForRequester: async () => ({}),
      resolvePersonProfile: async () => ({ kind: 'notFound' }),
      resolveRowScope: async () => null,
      viewerSeesHiddenUsers: () => false,
      getDirectoryHiddenUserIds: async () => [],
      ...overrides,
    },
  };
}

describe('buildUserMongoFilter (CONTRACT.md Rulings R1-R5)', () => {
  it('excludes platformSuperUser unconditionally and defaults status to active', async () => {
    const svcFilterSeen = [];
    const deps = {
      Role: fakeRole().Role,
      buildUserListMongoFilter: async (f) => {
        svcFilterSeen.push(f);
        return { ...f };
      },
    };
    const { mongoFilter, filtersApplied } = await buildUserMongoFilter({}, { user: VIEWER, deps });
    assert.equal(mongoFilter.platformSuperUser.$ne, true);
    assert.equal(svcFilterSeen[0].status, 'active');
    assert.equal(filtersApplied.status, 'active');
  });

  it('strips the status:"all" sentinel before calling buildUserListMongoFilter', async () => {
    const svcFilterSeen = [];
    const deps = {
      Role: fakeRole().Role,
      buildUserListMongoFilter: async (f) => {
        svcFilterSeen.push(f);
        return {};
      },
    };
    await buildUserMongoFilter({ status: 'all' }, { user: VIEWER, deps });
    assert.equal('status' in svcFilterSeen[0], false);
  });

  it('maps location/domain/education to buildUserListMongoFilter\'s plural keys', async () => {
    const svcFilterSeen = [];
    const deps = {
      Role: fakeRole().Role,
      buildUserListMongoFilter: async (f) => {
        svcFilterSeen.push(f);
        return {};
      },
    };
    await buildUserMongoFilter({ location: 'Pune', domain: 'Sales', education: 'MBA' }, { user: VIEWER, deps });
    assert.deepEqual(svcFilterSeen[0].locations, ['Pune']);
    assert.deepEqual(svcFilterSeen[0].domains, ['Sales']);
    assert.deepEqual(svcFilterSeen[0].education, ['MBA']);
  });

  it('resolves a role filter to roleIds and never sets buildUserListMongoFilter\'s own role key', async () => {
    const { Role } = fakeRole([
      { _id: 'r1', name: 'Administrator', slug: 'administrator', aliases: [], previousNames: [], status: 'active' },
    ]);
    const svcFilterSeen = [];
    const deps = {
      Role,
      buildUserListMongoFilter: async (f) => {
        svcFilterSeen.push(f);
        return {};
      },
    };
    const { mongoFilter } = await buildUserMongoFilter({ role: 'Administrator' }, { user: VIEWER, deps });
    assert.equal('role' in svcFilterSeen[0], false);
    assert.deepEqual(mongoFilter.roleIds, { $in: ['r1'] });
  });

  it('throws a tool error listing valid role names for an unknown role', async () => {
    const { Role } = fakeRole([
      { _id: 'r1', name: 'Administrator', slug: 'administrator', aliases: [], previousNames: [], status: 'active' },
    ]);
    const deps = { Role, buildUserListMongoFilter: async (f) => f };
    await assert.rejects(
      () => buildUserMongoFilter({ role: 'Wizard' }, { user: VIEWER, deps }),
      /Unknown role name.*Wizard.*Administrator/s
    );
  });
});

describe('count_users', () => {
  it('counts with platform-super excluded and echoes filtersApplied', async () => {
    const { User, calls } = fakeUser({ count: 12 });
    const out = await countUsers.execute({}, ctxFor({ User }));
    assert.equal(out.total, 12);
    assert.equal(calls.countDocuments[0].platformSuperUser.$ne, true);
    assert.equal(out.filtersApplied.status, 'active');
  });

  it('groupBy status covers every status unless a status was asked for', async () => {
    const { User, calls } = fakeUser({
      aggregateResults: [{ _id: 'active', count: 5 }, { _id: 'disabled', count: 1 }],
    });
    const out = await countUsers.execute({ groupBy: 'status' }, ctxFor({ User }));
    assert.equal('status' in calls.aggregate[0][0].$match, false);
    assert.deepEqual(out.groups, [{ value: 'active', count: 5 }, { value: 'disabled', count: 1 }]);
    assert.equal(out.filtersApplied.status, 'all');
  });

  it('groupBy role resolves role ids to names via one batched lookup', async () => {
    const { Role } = fakeRole([{ _id: 'r1', name: 'Recruiter' }, { _id: 'r2', name: 'Administrator' }]);
    const { User, calls } = fakeUser({ aggregateResults: [{ _id: 'r1', count: 4 }, { _id: 'r2', count: 2 }] });
    const out = await countUsers.execute({ groupBy: 'role' }, ctxFor({ User, Role }));
    assert.deepEqual(calls.aggregate[0][1], { $unwind: '$roleIds' });
    assert.deepEqual(out.groups, [{ value: 'Recruiter', count: 4 }, { value: 'Administrator', count: 2 }]);
  });

  it('caps groups at 25 with otherCount', async () => {
    const aggregateResults = Array.from({ length: 30 }, (_, i) => ({ _id: `s${i}`, count: 30 - i }));
    const { User } = fakeUser({ aggregateResults });
    const out = await countUsers.execute({ groupBy: 'status' }, ctxFor({ User }));
    assert.equal(out.groups.length, 25);
    assert.equal(out.otherCount, 5 + 4 + 3 + 2 + 1);
  });

  it('fails closed without a user id instead of running unrestricted', async () => {
    const { User } = fakeUser();
    for (const user of [undefined, null, {}, { roleIds: [] }]) {
      const ctx = { ...ctxFor({ User }), user };
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => countUsers.execute({}, ctx), /user with an id/);
    }
  });

  it('has users.read access', () => {
    assert.deepEqual(countUsers.access, PEOPLE_ACCESS);
  });

  it('renders a total fact when ungrouped, and a table (no count facts) when grouped', () => {
    const plain = countUsers.render({ total: 4, filtersApplied: {} });
    assert.deepEqual(plain.blocks, []);
    assert.equal(plain.facts.counts[0].total, 4);
    assert.equal(plain.facts.counts[0].label, 'users');

    const grouped = countUsers.render({ total: 5, groupBy: 'role', groups: [{ value: 'Recruiter', count: 5 }] });
    assert.equal(grouped.blocks[0].type, 'table');
    assert.deepEqual(grouped.facts.counts, []);
  });
});

describe('list_users', () => {
  it('lists rows with batched role names and never leaks private fields', async () => {
    const { Role } = fakeRole([{ _id: 'r1', name: 'Recruiter' }]);
    const docs = [{
      _id: 'u1', name: 'Asha', email: 'asha@example.com', status: 'active',
      roleIds: ['r1'], lastLoginAt: new Date('2026-01-01'),
      // A lean doc could in principle carry these (schema `private: true` fields
      // only get stripped by the toJSON transform, which .lean() bypasses) — the
      // tool must never spread the raw doc into a row regardless.
      password: 'hash', failedLoginCount: 3, loginLockedUntil: new Date(),
    }];
    const { User } = fakeUser({ count: 1, docs });
    const out = await listUsers.execute({ filters: {}, limit: 10 }, ctxFor({ User, Role }));
    assert.equal(out.total, 1);
    const row = out.users[0];
    assert.deepEqual(Object.keys(row).sort(), ['email', 'id', 'lastLoginAt', 'name', 'roles', 'status']);
    assert.deepEqual(row.roles, ['Recruiter']);
    assert.equal('password' in row, false);
    assert.equal('failedLoginCount' in row, false);
    assert.equal('loginLockedUntil' in row, false);
  });

  it('clamps limit at 25', async () => {
    const { User, calls } = fakeUser({ docs: [] });
    await listUsers.execute({ limit: 500 }, ctxFor({ User }));
    assert.deepEqual(calls.limit, [25]);
  });

  it('has users.read access', () => {
    assert.deepEqual(listUsers.access, PEOPLE_ACCESS);
  });

  it('renders the users table and a total fact', () => {
    const out = listUsers.render({
      total: 1,
      users: [{ name: 'Asha', email: 'a@x.com', roles: ['Recruiter'], status: 'active', lastLoginAt: null }],
    });
    assert.equal(out.blocks[0].type, 'table');
    assert.equal(out.facts.counts[0].total, 1);
    assert.equal(out.facts.counts[0].label, 'users');
  });
});

describe('get_user', () => {
  it('returns no matches for a malformed id without calling any service', async () => {
    const ctx = ctxFor({ getUserByIdForRequester: async () => { throw new Error('must not be called'); } });
    assert.deepEqual(await getUser.execute({ id: 'not-an-id' }, ctx), { matches: [] });
  });

  it('returns no matches when getUserByIdForRequester rejects (hidden / platform-super / not found)', async () => {
    const ctx = ctxFor({
      getUserByIdForRequester: async () => { throw new Error('not found'); },
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx), { matches: [] });
  });

  it('CONTRACT.md Ruling R6 — id path goes through getUserByIdForRequester before calling resolvePersonProfile with userId', async () => {
    const calls = [];
    const ctx = ctxFor({
      getUserByIdForRequester: async (id) => {
        calls.push(['getUserByIdForRequester', id]);
        return { _id: id };
      },
      resolvePersonProfile: async (args) => {
        calls.push(['resolvePersonProfile', args]);
        return { kind: 'notFound' };
      },
    });
    await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal(calls[0][0], 'getUserByIdForRequester');
    assert.equal(calls[1][1].userId, '64b7f0c2a1b2c3d4e5f60718');
    assert.equal('person' in calls[1][1], false);
  });

  it('the name path passes person, not userId', async () => {
    let seen;
    const ctx = ctxFor({ resolvePersonProfile: async (args) => { seen = args; return { kind: 'notFound' }; } });
    await getUser.execute({ name: 'Priya' }, ctx);
    assert.equal(seen.person, 'Priya');
    assert.equal('userId' in seen, false);
  });

  it('forwards ambiguous / notFound / unavailable as-is', async () => {
    const ambiguous = await getUser.execute(
      { name: 'A' },
      ctxFor({ resolvePersonProfile: async () => ({ kind: 'ambiguous', matches: [{ name: 'A1' }] }) })
    );
    assert.deepEqual(ambiguous, { matches: [{ name: 'A1' }] });

    const notFound = await getUser.execute(
      { name: 'nobody' },
      ctxFor({ resolvePersonProfile: async () => ({ kind: 'notFound' }) })
    );
    assert.deepEqual(notFound, { matches: [] });

    const unavailable = await getUser.execute(
      { name: 'x' },
      ctxFor({ resolvePersonProfile: async () => ({ kind: 'unavailable' }) })
    );
    assert.deepEqual(unavailable, { error: 'unavailable' });
  });

  it('CONTRACT.md R10 — notAuthorized degrades to scalar + full role definitions, never an error, never a bypass', async () => {
    const { Role } = fakeRole([{ _id: 'r1', name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: ['x'] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: ['r1'] });
    const ctx = ctxFor({
      User,
      Role,
      resolvePersonProfile: async () => ({
        kind: 'notAuthorized',
        identity: { userId: 'u1', name: 'Priya', email: 'priya@x.com' },
      }),
    });
    const out = await getUser.execute({ name: 'Priya' }, ctx);
    assert.equal(out.kind, 'unique');
    assert.equal(out.profiles, null);
    assert.equal(out.profileNote, 'not permitted');
    assert.deepEqual(out.roles.map((r) => r.name), ['Employee']);
    assert.deepEqual(out.identity.roles, ['Employee']);
    assert.equal('error' in out, false);
  });

  it('unique: roles[] comes from a fresh User.roleIds -> Role lookup (active + inactive), not identity.roleSlugs', async () => {
    const { Role } = fakeRole([
      { _id: 'r1', name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: ['employees.read'] },
      { _id: 'r2', name: 'Old Inactive Role', slug: 'oldinactiverole', aliases: [], status: 'inactive', permissions: [] },
    ]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: ['r1', 'r2'] });
    const ctx = ctxFor({
      User,
      Role,
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: 'u1', name: 'Priya', email: 'p@x.com', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: { fields: {}, visibleFields: [] }, student: { fields: {}, visibleFields: [] } },
        availableSections: [],
      }),
      resolveRowScope: async () => new Set(['someone-else']),
    });
    const out = await getUser.execute({ name: 'Priya' }, ctx);
    assert.equal(out.kind, 'unique');
    assert.deepEqual(out.roles.map((r) => r.name).sort(), ['Employee', 'Old Inactive Role']);
    // Ruling R7/R8 — row scope strips employee/candidate only; student is untouched.
    assert.equal('employee' in out.profiles, false);
    assert.equal('student' in out.profiles, true);
  });

  it('unique: leaves profiles untouched when the viewer is in the allowed row-scope set, or scope is unrestricted (null)', async () => {
    const { Role } = fakeRole([{ _id: 'r1', name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: [] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: ['r1'] });

    const scopedIn = await getUser.execute({ name: 'Priya' }, ctxFor({
      User,
      Role,
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: 'u1', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: {} },
        availableSections: [],
      }),
      resolveRowScope: async () => new Set(['u1']),
    }));
    assert.ok('employee' in scopedIn.profiles);

    const unrestricted = await getUser.execute({ name: 'Priya' }, ctxFor({
      User,
      Role,
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: 'u1', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: {} },
        availableSections: [],
      }),
      resolveRowScope: async () => null,
    }));
    assert.ok('employee' in unrestricted.profiles);
  });

  it('has users.read + person row-scope access', () => {
    assert.deepEqual(getUser.access, PEOPLE_PROFILE_ACCESS);
  });

  it('render: null for matches/error, a block + a get_user fact of total 1 for a unique find', () => {
    assert.equal(getUser.render({ matches: [] }), null);
    assert.equal(getUser.render({ error: 'unavailable' }), null);
    const out = getUser.render({
      kind: 'unique',
      identity: { name: 'Priya', roles: ['Employee'] },
      profiles: {},
    });
    assert.equal(out.facts.counts[0].total, 1);
    assert.equal(out.facts.counts[0].label, 'users');
  });
});

describe('CONTRACT.md R11 — Employee/Candidate provider selection is id-based, not name-based', () => {
  it('a role named Employee whose previousNames include "Candidate" still tags as the employee slug via id lookup, so selectProviders never runs the candidate provider for it', async () => {
    const employeeRoleId = '64b7f0c2a1b2c3d4e5f60001';
    const fakeRoleModel = {
      find: () => ({
        lean: async () => [{
          _id: employeeRoleId,
          name: 'Employee',
          slug: 'employee',
          aliases: [],
          previousNames: [{ name: 'Candidate', renamedAt: new Date() }],
          status: 'active',
        }],
      }),
    };
    try {
      // tagRoleSlugs is exactly what resolvePersonProfile calls to turn a user's
      // roleIds into the slugs selectProviders() picks Employee vs Candidate
      // from — it looks the id up in a Map keyed by Role._id, never by name or
      // previousNames, so a legacy rename cannot mis-route the profile.
      const slugMap = await tagRoleSlugs([employeeRoleId], { force: true, RoleModel: fakeRoleModel });
      assert.deepEqual([...slugMap.values()], ['employee']);

      const providers = selectProviders([...slugMap.values()]);
      assert.deepEqual(providers.map((p) => p.role), ['employee']);
      assert.ok(!providers.some((p) => p.role === 'candidate'), 'must not select the candidate provider');
    } finally {
      bustRoleRegistry();
    }
  });
});
