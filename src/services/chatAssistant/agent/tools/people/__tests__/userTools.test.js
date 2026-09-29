import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import countUsers from '../countUsers.tool.js';
import listUsers from '../listUsers.tool.js';
import getUser from '../getUser.tool.js';
import getMyProfile from '../getMyProfile.tool.js';
import { buildUserMongoFilter, PEOPLE_ACCESS, PEOPLE_PROFILE_ACCESS } from '../common.js';
import { tagRoleSlugs, bustRoleRegistry } from '../../../../roleRegistry.js';
import { selectProviders } from '../../../../personProfile/selectProviders.js';
import { resolvePersonProfile } from '../../../../personProfile/index.js';

const ROLE_ID_1 = '64b7f0c2a1b2c3d4e5f60001';
const ROLE_ID_2 = '64b7f0c2a1b2c3d4e5f60002';

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
      queryUsers: async () => ({ results: [] }),
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

  it('resolves a role filter to roleIds, cast to ObjectId (I-1), and never sets buildUserListMongoFilter\'s own role key', async () => {
    const { Role } = fakeRole([
      { _id: ROLE_ID_1, name: 'Administrator', slug: 'administrator', aliases: [], previousNames: [], status: 'active' },
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
    assert.equal(mongoFilter.roleIds.$in.length, 1);
    assert.ok(mongoFilter.roleIds.$in[0] instanceof mongoose.Types.ObjectId, 'roleIds.$in must hold ObjectId instances, not strings');
    assert.equal(mongoFilter.roleIds.$in[0].toString(), ROLE_ID_1);
  });

  it('throws a tool error listing valid role names for an unknown role', async () => {
    const { Role } = fakeRole([
      { _id: ROLE_ID_1, name: 'Administrator', slug: 'administrator', aliases: [], previousNames: [], status: 'active' },
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

  it('groupBy role: total is a distinct user count, not the sum of groups (I-3)', async () => {
    const { Role } = fakeRole([{ _id: 'r1', name: 'Recruiter' }, { _id: 'r2', name: 'Administrator' }]);
    // 5 distinct active users, 12 of them (well, some) hold 2 roles — group
    // counts sum to 6 (4 + 2), but only 5 distinct users match the filter.
    const { User, calls } = fakeUser({ count: 5, aggregateResults: [{ _id: 'r1', count: 4 }, { _id: 'r2', count: 2 }] });
    const out = await countUsers.execute({ groupBy: 'role' }, ctxFor({ User, Role }));
    assert.deepEqual(calls.aggregate[0][1], { $unwind: '$roleIds' });
    assert.deepEqual(out.groups, [{ value: 'Recruiter', count: 4 }, { value: 'Administrator', count: 2 }]);
    assert.equal(out.total, 5, 'total must be the distinct countDocuments result, not the group sum');
    assert.equal(out.assignmentCount, 6, 'the old sum-of-groups number is kept, separately labeled');
    assert.equal(calls.countDocuments.length, 1);
  });

  it('groupBy role + a role filter: the aggregate $match holds ObjectIds, not strings (I-1)', async () => {
    const { Role } = fakeRole([
      { _id: ROLE_ID_1, name: 'Recruiter', slug: 'recruiter', aliases: [], previousNames: [], status: 'active' },
    ]);
    const { User, calls } = fakeUser({ count: 4, aggregateResults: [{ _id: ROLE_ID_1, count: 4 }] });
    await countUsers.execute({ filters: { role: 'Recruiter' }, groupBy: 'status' }, ctxFor({ User, Role }));
    const $match = calls.aggregate[0][0].$match;
    assert.ok($match.roleIds.$in[0] instanceof mongoose.Types.ObjectId);
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

  it('groupBy role render title notes that a user with several roles appears in each role\'s row (I-3)', () => {
    const grouped = countUsers.render({
      total: 5, assignmentCount: 6, groupBy: 'role', groups: [{ value: 'Recruiter', count: 4 }],
    });
    assert.match(grouped.blocks[0].title, /appears in each/);
    const byStatus = countUsers.render({ total: 5, groupBy: 'status', groups: [{ value: 'active', count: 5 }] });
    assert.doesNotMatch(byStatus.blocks[0].title, /appears in each/);
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
    const ctx = ctxFor({
      getUserByIdForRequester: async () => { throw new Error('must not be called'); },
      queryUsers: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(await getUser.execute({ id: 'not-an-id' }, ctx), { matches: [] });
  });

  it('returns no matches when getUserByIdForRequester rejects (hidden / platform-super / not found)', async () => {
    const ctx = ctxFor({
      getUserByIdForRequester: async () => { throw new Error('not found'); },
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx), { matches: [] });
  });

  it('id path: resolvePersonProfile is called with the requester-scoped userId', async () => {
    const calls = [];
    const ctx = ctxFor({
      getUserByIdForRequester: async (id) => {
        calls.push(['getUserByIdForRequester', id]);
        return { _id: id, name: 'Priya', email: 'priya@x.com' };
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

  it('name path: no queryUsers match returns matches:[] without calling resolvePersonProfile', async () => {
    const ctx = ctxFor({
      queryUsers: async () => ({ results: [] }),
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(await getUser.execute({ name: 'Nobody' }, ctx), { matches: [] });
  });

  it('name path: more than one queryUsers match returns a scalar matches list without calling resolvePersonProfile', async () => {
    const seenArgs = [];
    const ctx = ctxFor({
      queryUsers: async (filter, options, requester) => {
        seenArgs.push({ filter, options, requester });
        return { results: [{ _id: 'u1', name: 'Priya A', email: 'a@x.com' }, { _id: 'u2', name: 'Priya B', email: 'b@x.com' }] };
      },
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    });
    const out = await getUser.execute({ name: 'Priya' }, ctx);
    assert.deepEqual(out, {
      matches: [
        { userId: 'u1', name: 'Priya A', email: 'a@x.com' },
        { userId: 'u2', name: 'Priya B', email: 'b@x.com' },
      ],
    });
    assert.equal(seenArgs[0].filter.search, 'Priya');
    assert.equal(seenArgs[0].requester, VIEWER);
  });

  it('CONTRACT.md Ruling R12 (review-final B-I1) — the name path excludes platformSuperUser and deleted accounts, mirroring getUserByIdForRequester', async () => {
    const seenArgs = [];
    const ctx = ctxFor({
      queryUsers: async (filter) => {
        seenArgs.push(filter);
        return { results: [] };
      },
    });
    await getUser.execute({ name: 'Priya' }, ctx);
    assert.equal(seenArgs[0].platformSuperUser.$ne, true);
    assert.equal(seenArgs[0].status.$ne, 'deleted');
  });

  it('R12 — a platform-super viewer is not excluded from their own name search', async () => {
    const seenArgs = [];
    const superViewer = { id: 'super-1', roleIds: [], platformSuperUser: true };
    const ctx = {
      ...ctxFor({
        queryUsers: async (filter) => {
          seenArgs.push(filter);
          return { results: [] };
        },
      }),
      user: superViewer,
    };
    await getUser.execute({ name: 'Owner' }, ctx);
    assert.equal('platformSuperUser' in seenArgs[0], false);
    assert.equal(seenArgs[0].status.$ne, 'deleted');
  });

  it('CONTRACT.md Ruling R13 (review-final m-4) — a single exact name/email match is preferred over the full matches list', async () => {
    const calls = [];
    const ctx = ctxFor({
      queryUsers: async () => ({
        results: [
          { _id: 'u1', name: 'John Smith', email: 'john@x.com' },
          { _id: 'u2', name: 'John Smithson', email: 'smithson@x.com' },
        ],
      }),
      resolvePersonProfile: async (args) => {
        calls.push(args);
        return { kind: 'notFound' };
      },
    });
    await getUser.execute({ name: 'John Smith' }, ctx);
    assert.equal(calls[0]?.userId, 'u1', 'must resolve the exact match, not ask to disambiguate');
  });

  it('R13 — falls back to the full matches list when more than one result matches exactly, or none does', async () => {
    const twoExact = await getUser.execute({ name: 'John Smith' }, ctxFor({
      queryUsers: async () => ({
        results: [{ _id: 'u1', name: 'John Smith', email: 'a@x.com' }, { _id: 'u2', name: 'John Smith', email: 'b@x.com' }],
      }),
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    }));
    assert.equal(twoExact.matches.length, 2);

    const noExact = await getUser.execute({ name: 'Smith' }, ctxFor({
      queryUsers: async () => ({
        results: [{ _id: 'u1', name: 'John Smith', email: 'a@x.com' }, { _id: 'u2', name: 'Jane Smith', email: 'b@x.com' }],
      }),
      resolvePersonProfile: async () => { throw new Error('must not be called'); },
    }));
    assert.equal(noExact.matches.length, 2);
  });

  it('name path: exactly one queryUsers match resolves through resolvePersonProfile with that user\'s id', async () => {
    const calls = [];
    const ctx = ctxFor({
      queryUsers: async () => ({ results: [{ _id: 'u1', name: 'Priya', email: 'p@x.com' }] }),
      resolvePersonProfile: async (args) => {
        calls.push(args);
        return { kind: 'notFound' };
      },
    });
    await getUser.execute({ name: 'Priya' }, ctx);
    assert.equal(calls[0].userId, 'u1');
  });

  it('forwards notFound / unavailable as-is', async () => {
    const notFound = await getUser.execute(
      { id: '64b7f0c2a1b2c3d4e5f60718' },
      ctxFor({
        getUserByIdForRequester: async (id) => ({ _id: id }),
        resolvePersonProfile: async () => ({ kind: 'notFound' }),
      })
    );
    assert.deepEqual(notFound, { matches: [] });

    const unavailable = await getUser.execute(
      { id: '64b7f0c2a1b2c3d4e5f60718' },
      ctxFor({
        getUserByIdForRequester: async (id) => ({ _id: id }),
        resolvePersonProfile: async () => ({ kind: 'unavailable' }),
      })
    );
    assert.deepEqual(unavailable, { error: 'unavailable' });
  });

  it('C-1 — notAuthorized never carries identity from resolvePersonProfile; get_user builds it from its own requester-scoped lookup', async () => {
    const { Role } = fakeRole([{ _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: ['x'] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1] });
    const ctx = ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya', email: 'priya@x.com' }),
      // The real resolvePersonProfile's notAuthorized branch carries no identity
      // (reverted — see personProfile/index.js). Simulating that exact shape here.
      resolvePersonProfile: async () => ({ kind: 'notAuthorized' }),
    });
    const out = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal(out.kind, 'unique');
    assert.equal(out.profiles, null);
    assert.equal(out.profileNote, 'not permitted');
    assert.equal(out.identity.userId, '64b7f0c2a1b2c3d4e5f60718');
    assert.equal(out.identity.name, 'Priya');
    assert.equal(out.identity.email, 'priya@x.com');
    assert.deepEqual(out.roles.map((r) => r.name), ['Employee']);
    assert.equal('error' in out, false);
  });

  it('unique: roles[] comes from a fresh User.roleIds -> Role lookup (active + inactive), not identity.roleSlugs', async () => {
    const { Role } = fakeRole([
      { _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: ['employees.read'] },
      { _id: ROLE_ID_2, name: 'Old Inactive Role', slug: 'oldinactiverole', aliases: [], status: 'inactive', permissions: [] },
    ]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1, ROLE_ID_2] });
    const ctx = ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya', email: 'p@x.com' }),
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: '64b7f0c2a1b2c3d4e5f60718', name: 'Priya', email: 'p@x.com', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: { fields: {}, visibleFields: [] }, student: { fields: {}, visibleFields: [] } },
        availableSections: ['employee-identity', 'student-identity'],
      }),
      resolveRowScope: async () => new Set(['someone-else']),
    });
    const out = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal(out.kind, 'unique');
    assert.deepEqual(out.roles.map((r) => r.name).sort(), ['Employee', 'Old Inactive Role']);
    // Ruling R7/R8 — row scope strips employee/candidate only; student is untouched.
    assert.equal('employee' in out.profiles, false);
    assert.equal('student' in out.profiles, true);
  });

  it('m-1 — a stripped employee/candidate profile is dropped from availableSections too, with a profileNote; a section a remaining provider still contributes (e.g. "identity") stays listed', async () => {
    const { Role } = fakeRole([{ _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: [] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1] });
    const ctx = ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya' }),
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: '64b7f0c2a1b2c3d4e5f60718', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        // fieldProjector's section keys ('identity', 'employment', …) are not
        // role-prefixed and can be shared across providers — here both the
        // (stripped) employee provider and the (kept) student provider
        // contribute an 'identity' section.
        profiles: {
          employee: { fields: {}, visibleFields: ['name'], sections: ['identity', 'employment'] },
          student: { fields: {}, visibleFields: ['name'], sections: ['identity'] },
        },
        availableSections: ['identity', 'employment'],
      }),
      resolveRowScope: async () => new Set(['someone-else']),
    });
    const out = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal('employee' in out.profiles, false);
    assert.ok('student' in out.profiles);
    // 'employment' only ever came from employee (stripped) — gone. 'identity'
    // is still contributed by student (kept) — stays.
    assert.deepEqual(out.availableSections, ['identity']);
    assert.equal(out.profileNote, 'employee/candidate profile not visible to you');
  });

  it('m-1 — no profileNote and availableSections untouched when nothing was stripped', async () => {
    const { Role } = fakeRole([{ _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: [] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1] });
    const ctx = ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya' }),
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: '64b7f0c2a1b2c3d4e5f60718', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { student: { fields: {}, visibleFields: ['name'], sections: ['identity'] } },
        availableSections: ['identity'],
      }),
      // Row-scoped out, but there was never an employee/candidate section to strip.
      resolveRowScope: async () => new Set(['someone-else']),
    });
    const out = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal('profileNote' in out, false);
    assert.deepEqual(out.availableSections, ['identity']);
  });

  it('unique: leaves profiles and availableSections untouched when the viewer is in the allowed row-scope set, or scope is unrestricted (null)', async () => {
    const { Role } = fakeRole([{ _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: [] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1] });

    const scopedIn = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya' }),
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: '64b7f0c2a1b2c3d4e5f60718', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: {} },
        availableSections: ['employee-identity'],
      }),
      resolveRowScope: async () => new Set(['64b7f0c2a1b2c3d4e5f60718']),
    }));
    assert.ok('employee' in scopedIn.profiles);
    assert.deepEqual(scopedIn.availableSections, ['employee-identity']);
    assert.equal('profileNote' in scopedIn, false);

    const unrestricted = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctxFor({
      User,
      Role,
      getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya' }),
      resolvePersonProfile: async () => ({
        kind: 'unique',
        identity: { userId: '64b7f0c2a1b2c3d4e5f60718', name: 'Priya', roles: ['Employee'], roleSlugs: ['employee'] },
        profiles: { employee: {} },
        availableSections: ['employee-identity'],
      }),
      resolveRowScope: async () => null,
    }));
    assert.ok('employee' in unrestricted.profiles);
  });

  it('end to end through the real resolvePersonProfile (read-only: it has no writers)', async () => {
    const { Role } = fakeRole([{ _id: ROLE_ID_1, name: 'Employee', slug: 'employee', aliases: [], status: 'active', permissions: [] }]);
    const { User } = fakeUser();
    User.findById = () => chainable({ roleIds: [ROLE_ID_1] });

    const ctx = {
      user: VIEWER,
      requestId: 'req-1',
      deps: {
        User,
        Role,
        getUserByIdForRequester: async (id) => ({ _id: id, name: 'Priya', email: 'priya@x.com' }),
        resolveRowScope: async () => null,
        // resolvePersonProfile itself is intentionally NOT stubbed here — peopleDeps
        // falls back to the REAL implementation, exercised end to end with its own
        // sub-dependencies (which get_user forwards unchanged via `deps: ctx.deps`).
        getUserPermissionContext: async () => ({ isAdmin: false, permissions: new Set(['employees.read']) }),
        tagRoleSlugs: async () => new Map([[ROLE_ID_1, 'employee']]),
        tagRoleDisplayNames: async () => new Map([[ROLE_ID_1, 'Employee']]),
        selectProviders: () => [],
        loadUserById: async (id) => ({ _id: id, name: 'Priya', email: 'priya@x.com', roleIds: [ROLE_ID_1] }),
      },
    };

    const out = await getUser.execute({ id: '64b7f0c2a1b2c3d4e5f60718' }, ctx);
    assert.equal(out.kind, 'unique');
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

describe('personProfile.resolvePersonProfile — direct coverage of the C-1 fix', () => {
  const NOT_AUTH_VIEWER = { id: 'viewer-1', roleIds: [] };

  it('C-1 regression — the default notAuthorized result carries no identity', async () => {
    const profile = await resolvePersonProfile({
      userId: 'p9',
      viewer: NOT_AUTH_VIEWER,
      deps: {
        loadUserById: async () => ({ _id: 'p9', name: 'Someone', email: 'someone@x.com', roleIds: [] }),
        getUserPermissionContext: async () => ({ isAdmin: false, permissions: new Set() }),
      },
    });
    assert.deepEqual(profile, { kind: 'notAuthorized' });
  });
});

describe('CONTRACT.md R11 — Employee/Candidate provider selection is id-based, not name-based', () => {
  it('a role named Employee whose previousNames include "Candidate" still tags as the employee slug via id lookup, so selectProviders never runs the candidate provider for it', async () => {
    const employeeRoleId = ROLE_ID_1;
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

describe('get_my_profile', () => {
  const VIEWER = { id: 'u-self', adminId: 'a-1' };

  it('resolves the viewer themself, read-only, with impersonation passed through', async () => {
    let seen;
    const ctx = {
      user: { ...VIEWER, __impersonating: true },
      deps: {
        resolvePersonProfile: async (args) => {
          seen = args;
          return { kind: 'unique', identity: { userId: 'u-self', name: 'Me', roles: ['Employee'] }, profiles: {}, availableSections: [] };
        },
      },
    };
    const out = await getMyProfile.execute({}, ctx);
    assert.equal(seen.userId, 'u-self');
    assert.equal(seen.viewer.id, 'u-self');
    assert.equal(seen.impersonating, true);
    assert.equal(out.identity.name, 'Me');
    assert.equal(getMyProfile.render(out).blocks.length, 1);
  });

  it('returns an error, never another person, when the profile is unavailable', async () => {
    const ctx = { user: VIEWER, deps: { resolvePersonProfile: async () => ({ kind: 'unavailable' }) } };
    assert.ok((await getMyProfile.execute({}, ctx)).error);
  });

  it('needs no permission (self-scoped note access)', () => {
    assert.equal(getMyProfile.access.anyOf, undefined);
    assert.ok(getMyProfile.access.note);
  });
});
