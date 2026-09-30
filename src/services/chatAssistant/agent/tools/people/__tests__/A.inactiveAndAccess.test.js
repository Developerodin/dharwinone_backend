import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countUsers from '../countUsers.tool.js';
import listUsers from '../listUsers.tool.js';
import whatCanIDo from '../whatCanIDo.tool.js';
import peopleDomain from '../index.js';
import { buildUserMongoFilter } from '../common.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const NOW = new Date('2026-09-30T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWER = { id: 'viewer-1', roleIds: [] };

function chainable(result) {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => result };
  return q;
}

function deps(overrides = {}) {
  const seen = { svc: [], count: [], find: [] };
  return {
    seen,
    deps: {
      Role: { find: () => chainable([]) },
      User: {
        countDocuments: async (f) => { seen.count.push(f); return 3; },
        find: (f) => { seen.find.push(f); return chainable([]); },
      },
      buildUserListMongoFilter: async (f) => { seen.svc.push(f); return {}; },
      now: () => NOW,
      ...overrides,
    },
  };
}

describe('people filters.inactiveDays / neverLoggedIn (CONTRACT.md R16)', () => {
  it('inactiveDays = last login before the cutoff, or never logged in on an account older than the cutoff', async () => {
    const { deps: d, seen } = deps();
    const { mongoFilter, filtersApplied } = await buildUserMongoFilter({ inactiveDays: 30 }, { user: VIEWER, deps: d });
    const cutoff = new Date(NOW.getTime() - 30 * DAY_MS);
    assert.deepEqual(mongoFilter.$and, [
      { $or: [{ lastLoginAt: { $lt: cutoff } }, { lastLoginAt: null, createdAt: { $lt: cutoff } }] },
    ]);
    assert.equal(filtersApplied.inactiveDays, 30);
    assert.equal(filtersApplied.status, 'active');
    assert.equal('inactiveDays' in seen.svc[0], false, 'never spread into buildUserListMongoFilter');
  });

  it('neverLoggedIn true/false map to lastLoginAt null / not null and never reach the service filter', async () => {
    const a = deps();
    const { mongoFilter: never } = await buildUserMongoFilter({ neverLoggedIn: true }, { user: VIEWER, deps: a.deps });
    assert.deepEqual(never.$and, [{ lastLoginAt: null }]);
    assert.equal('neverLoggedIn' in a.seen.svc[0], false);
    const b = deps();
    const { mongoFilter: has } = await buildUserMongoFilter({ neverLoggedIn: false }, { user: VIEWER, deps: b.deps });
    assert.deepEqual(has.$and, [{ lastLoginAt: { $ne: null } }]);
  });

  it('ANDs onto an existing $and from the service instead of replacing it', async () => {
    const { deps: d } = deps({ buildUserListMongoFilter: async () => ({ $and: [{ x: 1 }] }) });
    const { mongoFilter } = await buildUserMongoFilter({ neverLoggedIn: true }, { user: VIEWER, deps: d });
    assert.deepEqual(mongoFilter.$and, [{ x: 1 }, { lastLoginAt: null }]);
  });

  it('adds no login clause when neither filter is set', async () => {
    const { deps: d } = deps();
    const { mongoFilter } = await buildUserMongoFilter({}, { user: VIEWER, deps: d });
    assert.equal('$and' in mongoFilter, false);
  });

  it('count_users happy path: the count query carries the inactivity clause', async () => {
    const { deps: d, seen } = deps();
    const out = await countUsers.execute({ filters: { inactiveDays: 7 } }, { user: VIEWER, deps: d });
    assert.equal(out.total, 3);
    assert.ok(seen.count[0].$and[0].$or, 'inactivity $or reached countDocuments');
  });

  it('list_users keeps its existing limit (default 10, max 25) with the new filters', async () => {
    const { value } = listUsers.input.validate({ filters: { neverLoggedIn: true } });
    assert.equal(value.limit, 10);
    assert.ok(listUsers.input.validate({ limit: 26 }).error);
    const { deps: d, seen } = deps();
    const out = await listUsers.execute(value, { user: VIEWER, deps: d });
    assert.equal(out.total, 3);
    assert.deepEqual(seen.find[0].$and, [{ lastLoginAt: null }]);
  });

  it('rejects inactiveDays out of range', () => {
    assert.ok(countUsers.input.validate({ filters: { inactiveDays: 0 } }).error);
    assert.ok(countUsers.input.validate({ filters: { inactiveDays: 4000 } }).error);
  });

  it('access denied: count_users/list_users still need users.read', async () => {
    const noPerms = { id: 'u', authContext: { permissions: new Set() } };
    assert.equal((await checkAccessRule(countUsers.access, noPerms)).ok, false);
    assert.equal((await checkAccessRule(listUsers.access, noPerms)).ok, false);
  });
});

describe('what_can_i_do', () => {
  const ctx = (mine, user = VIEWER) => ({ user, requestId: 'r', deps: { getMyPermissionsForFrontend: async () => mine } });

  it('groups the caller\'s own permissions into modules and plain verbs, and names modules without access', async () => {
    let asked;
    const out = await whatCanIDo.execute({}, {
      user: VIEWER,
      deps: {
        getMyPermissionsForFrontend: async (u) => {
          asked = u;
          return {
            permissions: ['ats.jobs:view,create', 'ats.candidates:view', 'settings.users.impersonate:view', 'devTickets.view', 'garbage'],
            roleNames: ['Recruiter'],
            isPlatformSuperUser: false,
          };
        },
      },
    });
    assert.equal(asked, VIEWER, 'reads the caller, never another user');
    assert.deepEqual(out.roles, ['Recruiter']);
    assert.equal(out.fullAccess, false);
    assert.deepEqual(out.modules, [
      { module: 'Settings', areas: [{ area: 'Impersonate users (Login as)', can: ['view'] }] },
      { module: 'ATS', areas: [{ area: 'Jobs', can: ['view', 'add'] }, { area: 'Candidates', can: ['view'] }] },
      { module: 'Support', areas: [{ area: 'Help & Support', can: ['view'] }] },
    ]);
    assert.ok(out.modulesWithoutAccess.includes('Logs'));
    assert.ok(!out.modulesWithoutAccess.includes('ATS'));
  });

  it('names modules only for what is not accessible — no data, no permission strings', async () => {
    const out = await whatCanIDo.execute({}, ctx({ permissions: [], roleNames: [], isPlatformSuperUser: false }));
    assert.deepEqual(out.modules, []);
    assert.ok(out.modulesWithoutAccess.every((m) => typeof m === 'string' && !m.includes(':')));
    assert.equal(out.modulesWithoutAccess.length, 11);
  });

  it('platform super user has full access and nothing listed as missing', async () => {
    const out = await whatCanIDo.execute({}, ctx({ permissions: ['logs.activity:view'], roleNames: [], isPlatformSuperUser: true }));
    assert.equal(out.fullAccess, true);
    assert.deepEqual(out.modulesWithoutAccess, []);
  });

  it('missing data: no role names or permissions come back as empty lists, not invented ones', async () => {
    const out = await whatCanIDo.execute({}, ctx({}));
    assert.deepEqual(out.roles, []);
    assert.deepEqual(out.modules, []);
  });

  it('flags impersonation so the reply can say whose access this is', async () => {
    const out = await whatCanIDo.execute({}, ctx({ permissions: [] }, { ...VIEWER, __impersonating: true }));
    assert.equal(out.impersonating, true);
  });

  it('needs no permission (self-scoped note access) and fails closed without a user id', async () => {
    assert.equal((await checkAccessRule(whatCanIDo.access, { id: 'u', authContext: { permissions: new Set() } })).ok, true);
    await assert.rejects(whatCanIDo.execute({}, { deps: { getMyPermissionsForFrontend: async () => ({}) } }), /user with an id/);
  });
});

describe('people domain module', () => {
  it('exports a one-line summary of at most 120 chars and registers what_can_i_do', () => {
    assert.ok(peopleDomain.summary.length <= 120 && !/[\r\n]/.test(peopleDomain.summary));
    assert.ok(peopleDomain.tools.some((t) => t.name === 'what_can_i_do'));
  });
});
