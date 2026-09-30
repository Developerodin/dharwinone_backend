import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import listActivity from '../listActivity.tool.js';
import listImpersonations from '../listImpersonations.tool.js';
import auditDomain from '../index.js';
import { changesFrom, actionsInGroup, entityQuery, isSensitiveName, NOT_CAPTURED } from '../common.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const UID = '64b7f0c2a1b2c3d4e5f60aaa';

const userWith = (perms, extra = {}) => ({
  id: UID,
  _id: UID,
  email: 'someone@example.com',
  authContext: { permissions: new Set(perms) },
  ...extra,
});

/** Real gate + real resolveActivityLogListFilter; only the service query is faked. */
function activityCtx(user, { results = [], totalResults = results.length } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      user,
      requestId: 'r',
      deps: {
        isDesignatedSuperadminEmail: () => false,
        queryActivityLogs: async (filter, options, viewer) => {
          calls.push({ filter, options, viewer });
          return { results, totalResults };
        },
      },
    },
  };
}

describe('list_activity — access (requireActivityLogsListAccess, reused)', () => {
  it('returns forbidden and never queries when the page gate refuses the viewer', async () => {
    const { ctx, calls } = activityCtx(userWith([]));
    const out = await listActivity.execute({ filters: {} }, ctx);
    assert.equal(out.forbidden, true);
    assert.equal(calls.length, 0);
  });

  it('lets the designated superadmin email through with no permission, like the page', async () => {
    const { ctx, calls } = activityCtx(userWith([]));
    ctx.deps.isDesignatedSuperadminEmail = () => true;
    ctx.deps.activityGate = (req, res, next) => next();
    const out = await listActivity.execute({ filters: { actor: 'Priya' } }, ctx);
    assert.equal(out.forbidden, undefined);
    assert.equal(calls[0].filter.actor, 'Priya', 'designated email is the view-all tier');
    assert.equal(out.scope, 'everyone');
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(listActivity.execute({}, { deps: {} }), /user with an id/);
  });
});

describe('list_activity — row scope (resolveActivityLogListFilter tiers)', () => {
  it('view tier: forced to the viewer\'s own rows; filters it cannot use are reported, not silently applied', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read']));
    const out = await listActivity.execute({ filters: { actor: 'Priya', action: 'user.login' } }, ctx);
    assert.deepEqual(calls[0].filter, { actor: UID });
    assert.equal(out.scope, 'your own activity only');
    assert.deepEqual(out.ignoredFilters.sort(), ['action/actionGroup', 'actor']);
    assert.equal(calls[0].viewer, ctx.user, 'viewer passed so the service applies hidden-user rules');
  });

  it('filter tier (create + edit): own rows, keeps action/type/window, drops actor and target name', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.create', 'activity.edit']));
    const out = await listActivity.execute(
      { filters: { action: 'job.delete', targetType: 'Job', target: 'Backend Dev', between: { from: '2026-09-01', to: '2026-09-30' } } },
      ctx,
    );
    const f = calls[0].filter;
    assert.equal(f.actor, UID);
    assert.equal(f.action, 'job.delete');
    assert.equal(f.entityType, 'Job');
    assert.equal('entityId' in f, false);
    assert.equal(f.startDate, '2026-08-31T18:30:00.000Z');
    assert.equal(f.endDate, '2026-09-30T18:29:59.999Z');
    assert.deepEqual(out.ignoredFilters, ['target']);
  });

  it('view-all tier (delete): everyone; actionGroup becomes the group\'s action keys', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.delete']));
    const out = await listActivity.execute({ filters: { actor: 'Priya', actionGroup: 'Users & roles' }, limit: 5 }, ctx);
    const f = calls[0].filter;
    assert.equal(f.actor, 'Priya');
    assert.ok(f.action.$in.includes('user.login') && f.action.$in.includes('role.update'));
    assert.ok(!f.action.$in.some((a) => a.startsWith('job.')));
    assert.equal(out.scope, 'everyone');
    assert.equal(out.ignoredFilters, undefined);
    assert.deepEqual(calls[0].options, { limit: 5, page: 1, sortBy: 'createdAt:desc' });
  });

  it('the Attendance group asks the service to include attendance rows', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.delete']));
    await listActivity.execute({ filters: { actionGroup: 'Attendance' } }, ctx);
    assert.equal(calls[0].filter.includeAttendance, 'true');
    assert.ok(calls[0].filter.action.$in.every((a) => a.startsWith('attendance.')));
  });

  it('defaults limit to 20 and caps it at 50', () => {
    assert.equal(listActivity.input.validate({}).value.limit, 20);
    assert.ok(listActivity.input.validate({ limit: 51 }).error);
  });
});

describe('list_activity — rows', () => {
  it('happy path: maps a row to who / action / record / old → new', async () => {
    const { ctx } = activityCtx(userWith(['activity.read', 'activity.delete']), {
      totalResults: 42,
      results: [{
        id: 'l1', createdAt: '2026-09-29T10:00:00.000Z', actor: { id: 'a1', name: 'Asha' }, action: 'role.update',
        entityType: 'Role', entityId: 'r1', entityName: 'Recruiter',
        metadata: { statusBefore: 'active', statusAfter: 'inactive', ip: '1.2.3.4' },
      }],
    });
    const out = await listActivity.execute({ filters: {} }, ctx);
    assert.equal(out.total, 42);
    assert.deepEqual(out.records[0], {
      id: 'l1', at: '2026-09-29T10:00:00.000Z', actor: 'Asha', actorId: 'a1', action: 'role.update', group: 'Users & roles',
      targetType: 'Role', targetId: 'r1', target: 'Recruiter', changes: [{ field: 'status', from: 'active', to: 'inactive' }],
    });
    const rendered = listActivity.render(out);
    assert.equal(rendered.facts.counts[0].total, 42);
  });

  it('missing data: no metadata, deleted actor, unresolved record → null, never invented', async () => {
    const { ctx } = activityCtx(userWith(['activity.read', 'activity.delete']), {
      results: [{ id: 'l2', createdAt: null, actor: null, action: 'job.delete', entityType: 'Candidate', entityId: 'x' }],
    });
    const [row] = (await listActivity.execute({ filters: {} }, ctx)).records;
    assert.equal(row.actor, null);
    assert.equal(row.target, null);
    assert.equal(row.changes, null);
    assert.equal(row.targetType, 'Employee', 'legacy Candidate type shown as Employee, like the page');
  });

  it('rejects action + actionGroup together, and target without targetType', async () => {
    const { ctx } = activityCtx(userWith(['activity.read', 'activity.delete']));
    await assert.rejects(listActivity.execute({ filters: { action: 'user.login', actionGroup: 'Users & roles' } }, ctx), /not both/);
    await assert.rejects(listActivity.execute({ filters: { target: 'Priya' } }, ctx), /targetType/);
  });
});

describe('audit common helpers', () => {
  it('changesFrom reads changes[], fromValue/toValue, field/newValue and Before/After pairs', () => {
    assert.deepEqual(changesFrom('candidate.update', { changes: [{ field: 'degree', from: 'a', to: 'b' }, { field: 'skills', changed: true }] }), [
      { field: 'degree', from: 'a', to: 'b' },
      { field: 'skills', valuesNotCaptured: true },
    ]);
    assert.deepEqual(changesFrom('placement.statusChange', { fromValue: 'Pending', toValue: 'Joined' }), [
      { field: 'value', from: 'Pending', to: 'Joined' },
    ]);
    assert.deepEqual(changesFrom('user.update', { field: 'status', newValue: 'disabled' }), [
      { field: 'status', from: null, to: 'disabled' },
    ]);
    assert.equal(changesFrom('user.login', { signInMethod: 'password' }), null);
  });

  it('never returns compensation / payroll / salary values', () => {
    assert.deepEqual(changesFrom('candidate.compensation.override', { before: { ctc: 10 }, after: { ctc: 12 } }), [
      { field: 'value', valueHidden: true },
    ]);
    assert.deepEqual(changesFrom('placement.compensationChange', { fromValue: '10', toValue: '12' }), [
      { field: 'value', valueHidden: true },
    ]);
    assert.deepEqual(changesFrom('candidate.update', { changes: [{ field: 'salaryRange', from: 1, to: 2 }] }), [
      { field: 'salaryRange', valueHidden: true },
    ]);
  });

  it('person targets: an id or a name matches both stored spellings', () => {
    assert.deepEqual(entityQuery('Employee', UID), { entityType: 'Candidate,Employee', entityId: UID });
    assert.deepEqual(entityQuery('Employee', 'Priya'), { entityType: 'Candidate,Employee', entityId: 'Priya' });
    assert.deepEqual(entityQuery('User', 'Priya'), { entityType: 'User', entityId: 'Priya' });
  });

  it('action groups mirror the Activity Logs filter buckets', () => {
    assert.ok(actionsInGroup('Employee').every((a) => a.startsWith('candidate.') || a.startsWith('employee.')));
    assert.ok(actionsInGroup('Organization').includes('org.mutate.denied'));
  });
});

function fakeImpersonation(rows, total = rows.length) {
  const calls = { count: [], find: [], select: [] };
  const Impersonation = {
    countDocuments: async (m) => { calls.count.push(m); return total; },
    find: (m) => {
      calls.find.push(m);
      const q = {
        select: (s) => { calls.select.push(s); return q; },
        sort: () => q,
        limit: () => q,
        lean: async () => rows,
      };
      return q;
    },
  };
  return { Impersonation, calls };
}

const fakeUsers = (docs) => ({
  find: (m) => {
    const ids = (m?._id?.$in || []).map(String);
    const q = { select: () => q, lean: async () => docs.filter((d) => ids.includes(String(d._id))) };
    return q;
  },
});

function impCtx({ rows = [], users = [], hiddenIds = [], seesHidden = false, queryUsers, viewer } = {}) {
  const { Impersonation, calls } = fakeImpersonation(rows);
  return {
    calls,
    ctx: {
      user: viewer ?? userWith(['users.impersonate.read', 'activity.read', 'activity.delete']),
      requestId: 'r',
      deps: {
        isDesignatedSuperadminEmail: () => false,
        Impersonation,
        User: fakeUsers(users),
        viewerSeesHiddenUsers: () => seesHidden,
        getDirectoryHiddenUserIds: async () => hiddenIds,
        queryUsers: queryUsers ?? (async () => ({ results: [] })),
      },
    },
  };
}

describe('list_impersonations', () => {
  it('access mirrors POST /auth/impersonate: users.impersonate, or Administrator by name', async () => {
    const none = userWith([]);
    assert.equal((await checkAccessRule(listImpersonations.access, none, { isAdmin: async () => false })).ok, false);
    assert.equal((await checkAccessRule(listImpersonations.access, none, { isAdmin: async () => true })).ok, true);
    assert.equal((await checkAccessRule(listImpersonations.access, userWith(['users.impersonate.read']))).ok, true);
  });

  it('happy path: who / whom / start / end; never selects adminRefreshToken; reason and pages not captured', async () => {
    const { ctx, calls } = impCtx({
      rows: [
        { _id: 'i1', adminUser: 'a1', impersonatedUser: 't1', startedAt: new Date('2026-09-29T10:00:00Z'), endedAt: new Date('2026-09-29T10:30:00Z') },
        { _id: 'i2', adminUser: 'a1', impersonatedUser: 't1', startedAt: new Date('2026-09-30T04:00:00Z'), endedAt: null },
      ],
      users: [{ _id: 'a1', name: 'Asha' }, { _id: 't1', name: 'Priya' }],
    });
    const out = await listImpersonations.execute({ filters: {} }, ctx);
    assert.equal(calls.select[0], 'adminUser impersonatedUser startedAt endedAt');
    assert.equal(out.total, 2);
    assert.deepEqual(out.records[0], {
      id: 'i1', admin: 'Asha', target: 'Priya', startedAt: new Date('2026-09-29T10:00:00Z'),
      endedAt: new Date('2026-09-29T10:30:00Z'), durationMinutes: 30,
    });
    assert.equal(out.records[1].endedAt, null);
    assert.equal(out.records[1].durationMinutes, null);
    assert.equal(out.reason, NOT_CAPTURED);
    assert.equal(out.pagesViewed, NOT_CAPTURED);
    assert.equal(listImpersonations.render(out).facts.counts[0].total, 2);
  });

  it('row scope: hidden admins are excluded and hidden / platform-super targets are "Restricted user"', async () => {
    const { ctx, calls } = impCtx({
      rows: [{ _id: 'i1', adminUser: 'a1', impersonatedUser: 't1', startedAt: new Date(), endedAt: null }],
      users: [{ _id: 'a1', name: 'Asha' }, { _id: 't1', name: 'Owner', platformSuperUser: true }],
      hiddenIds: ['h1'],
    });
    const out = await listImpersonations.execute({ filters: {} }, ctx);
    assert.deepEqual(calls.count[0], { $and: [{ adminUser: { $nin: ['h1'] } }] });
    assert.equal(out.records[0].target, 'Restricted user');
  });

  it('resolves admin / target names through queryUsers, excluding platform-super accounts for normal viewers', async () => {
    const seen = [];
    const { ctx, calls } = impCtx({
      queryUsers: async (filter, options, requester) => {
        seen.push({ filter, options, requester });
        return { results: [{ id: 'a1' }] };
      },
    });
    await listImpersonations.execute({ filters: { admin: 'Asha', between: { from: '2026-09-01', to: '2026-09-01' } } }, ctx);
    assert.deepEqual(seen[0].filter, { search: 'Asha', platformSuperUser: { $ne: true } });
    assert.equal(seen[0].requester, ctx.user);
    assert.deepEqual(calls.count[0].$and, [
      { adminUser: { $in: ['a1'] } },
      { startedAt: { $gte: new Date('2026-08-31T18:30:00.000Z'), $lte: new Date('2026-09-01T18:29:59.999Z') } },
    ]);
  });

  it('an unknown name returns zero with notFound — never an unfiltered list', async () => {
    const { ctx, calls } = impCtx();
    const out = await listImpersonations.execute({ filters: { target: 'Nobody' } }, ctx);
    assert.deepEqual({ total: out.total, notFound: out.notFound }, { total: 0, notFound: 'target' });
    assert.equal(calls.count.length, 0);
  });

  it('missing data: a deleted user resolves to null, not a guessed name', async () => {
    const { ctx } = impCtx({ rows: [{ _id: 'i1', adminUser: 'gone', impersonatedUser: 'gone2', startedAt: new Date(), endedAt: null }] });
    const [row] = (await listImpersonations.execute({ filters: {} }, ctx)).records;
    assert.equal(row.admin, null);
    assert.equal(row.target, null);
  });

  it('noEndRecorded filters to sessions with no end, and it fails closed without a user id', async () => {
    const { ctx, calls } = impCtx({ seesHidden: true });
    await listImpersonations.execute({ filters: { noEndRecorded: true } }, ctx);
    assert.deepEqual(calls.count[0], { $and: [{ endedAt: null }] });
    await assert.rejects(listImpersonations.execute({}, { deps: {} }), /user with an id/);
  });
});

describe('audit domain module', () => {
  it('exports domain, a one-line summary ≤ 120 chars, instructions and both tools', () => {
    assert.equal(auditDomain.domain, 'audit');
    assert.ok(auditDomain.summary.length <= 120 && !/[\r\n]/.test(auditDomain.summary));
    assert.deepEqual(auditDomain.tools.map((t) => t.name), ['list_activity', 'list_impersonations']);
    assert.ok(auditDomain.tools.every((t) => t.measure), 'list tools declare a measure (Ruling R15)');
  });
});

describe('review fixes (Wave 1 adversarial pass)', () => {
  const fakeEmployees = (ids, seen) => ({
    find: (m) => {
      seen.push(m);
      const q = { select: () => q, limit: () => q, maxTimeMS: () => q, lean: async () => ids.map((_id) => ({ _id })) };
      return q;
    },
  });

  it('a person NAME matches rows stored as Employee AND Candidate (was Candidate only)', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.delete']));
    const seen = [];
    ctx.deps.Employee = fakeEmployees(['e1', 'e2'], seen);
    await listActivity.execute({ filters: { targetType: 'Employee', target: 'Pri.ya' } }, ctx);
    const f = calls[0].filter;
    assert.equal(f.entityType, 'Candidate,Employee');
    assert.equal('entityId' in f, false, 'a name must not reach the service as a raw entityId');
    assert.deepEqual(f.$or, [{ entityId: { $in: ['e1', 'e2'] } }]);
    assert.equal(String(seen[0].fullName), String(/^Pri\.ya/i), 'starts-with, regex-escaped, like the service');
  });

  it('a person name with no match filters to nothing, never to every person row', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.delete']));
    ctx.deps.Employee = fakeEmployees([], []);
    await listActivity.execute({ filters: { targetType: 'Employee', target: 'Nobody' } }, ctx);
    assert.deepEqual(calls[0].filter.$or, [{ entityId: { $in: [] } }]);
  });

  it('filter tier: the name lookup is skipped because entityId was dropped', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read', 'activity.create', 'activity.edit']));
    ctx.deps.Employee = { find: () => { throw new Error('must not look up'); } };
    const out = await listActivity.execute({ filters: { targetType: 'Employee', target: 'Priya' } }, ctx);
    assert.equal(calls[0].filter.$or, undefined);
    assert.deepEqual(out.ignoredFilters, ['target']);
  });

  it('scope says "own" for an own-rows viewer even when they filter by themselves', async () => {
    const { ctx } = activityCtx(userWith(['activity.read', 'activity.create', 'activity.edit']));
    const out = await listActivity.execute({ filters: { actor: UID } }, ctx);
    assert.equal(out.scope, 'your own activity only');
    assert.equal(out.ignoredFilters, undefined);
  });

  it('a gate that throws synchronously is a refusal, not a crash', async () => {
    const { ctx, calls } = activityCtx(userWith(['activity.read']));
    ctx.deps.activityGate = () => { throw new Error('boom'); };
    const out = await listActivity.execute({ filters: {} }, ctx);
    assert.equal(out.forbidden, true);
    assert.equal(calls.length, 0);
  });

  it('hides offer pay and employee identity/contact values stored inside changes[]', () => {
    const rows = changesFrom('offer.update', {
      changes: [
        { field: 'gross', from: 1, to: 2 }, { field: 'hra', from: 1, to: 2 }, { field: 'base', from: 1, to: 2 },
        { field: 'specialAllowances', from: 1, to: 2 }, { field: 'sevisId', from: 'a', to: 'b' },
        { field: 'eadCardNumber', from: 'a', to: 'b' }, { field: 'supervisorContact', from: 'a', to: 'b' },
        { field: 'panNumber', from: 'a', to: 'b' }, { field: 'dateOfBirth', from: 'a', to: 'b' },
        { field: 'workLocation', from: 'Pune', to: 'Delhi' },
      ],
    });
    assert.ok(rows.slice(0, 9).every((r) => r.valueHidden === true && !('from' in r)), JSON.stringify(rows));
    assert.deepEqual(rows[9], { field: 'workLocation', from: 'Pune', to: 'Delhi' });
    assert.equal(isSensitiveName('company'), false, '"pan" inside company is not a PAN');
    assert.equal(isSensitiveName('displayName'), false, '"pay" inside display is not pay');
  });

  it('hides a value that is a link or an email address whatever the field is called', () => {
    assert.deepEqual(changesFrom('candidate.update', { changes: [{ field: 'notes', from: null, to: 'mail a.b@x.com' }] }), [
      { field: 'notes', valueHidden: true },
    ]);
    assert.deepEqual(changesFrom('candidate.update', { changes: [{ field: 'resume', from: null, to: 'https://s3/x?sig=1' }] }), [
      { field: 'resume', valueHidden: true },
    ]);
  });

  it('reads the older object-shaped changes and top-level from/to (employee transfer)', () => {
    assert.deepEqual(
      changesFrom('candidate.update', { changes: { degree: { from: null, to: 'BSc' }, documents: '[changed]', ead: { from: null, to: 'x' } } }),
      [{ field: 'degree', from: null, to: 'BSc' }, { field: 'documents', valuesNotCaptured: true }, { field: 'ead', valueHidden: true }],
    );
    assert.deepEqual(changesFrom('employee.transfer', { from: { designation: 'A' }, to: { designation: 'B' } }), [
      { field: 'value', from: '{"designation":"A"}', to: '{"designation":"B"}' },
    ]);
  });

  it('list_impersonations: a viewer below the see-everyone Activity Logs tier sees only sessions they started', async () => {
    const { ctx, calls } = impCtx({ viewer: userWith(['users.impersonate.read', 'activity.read']), seesHidden: true });
    const out = await listImpersonations.execute({ filters: {} }, ctx);
    assert.deepEqual(calls.count[0], { $and: [{ adminUser: UID }] });
    assert.equal(out.scope, 'only sessions you started');
  });

  it('list_impersonations: an Administrator-by-name with no log permission is also own-only', async () => {
    const { ctx, calls } = impCtx({ viewer: userWith([]), seesHidden: true });
    await listImpersonations.execute({ filters: { noEndRecorded: true } }, ctx);
    assert.deepEqual(calls.count[0], { $and: [{ endedAt: null }, { adminUser: UID }] });
  });
});
