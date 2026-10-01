import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { defineTool } from '../defineTool.js';

// In-memory SageAction: every write in this file lands here, never in Mongo.
const rows = new Map();
const claimSets = [];

const matches = (row, filter) =>
  Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$gt' in v) return row[k] > v.$gt;
      if ('$lte' in v) return row[k] <= v.$lte;
      return false;
    }
    return String(row[k]) === String(v);
  });
const find = (filter) => [...rows.values()].find((r) => matches(r, filter)) ?? null;
// find + $set run synchronously inside lean(), so two concurrent claims cannot both match.
const chain = (fn) => ({ lean: async () => structuredClone(fn()) });

const FakeSageAction = {
  create: mock.fn(async (doc) => {
    rows.set(doc.key, structuredClone(doc));
    return doc;
  }),
  findOne: (filter) => chain(() => find(filter)),
  findOneAndUpdate: (filter, update) =>
    chain(() => {
      if (update.$set?.status === 'executing') claimSets.push({ ...update.$set });
      const row = find(filter);
      if (row) Object.assign(row, update.$set);
      return row;
    }),
  updateOne: async (filter, update) => {
    const row = find(filter);
    if (row) Object.assign(row, update.$set);
    return { modifiedCount: row ? 1 : 0 };
  },
};

let getAgentTools;
let confirmAction;
let cancelAction;
let checkPrepared;

before(async () => {
  mock.module('../../../../models/sageAction.model.js', {
    defaultExport: FakeSageAction,
    namedExports: { SAGE_ACTION_STATUSES: ['pending', 'executing', 'done', 'failed', 'cancelled', 'expired'] },
  });
  ({ getAgentTools } = await import('../toolRegistry.js'));
  ({ confirmAction, cancelAction, checkPrepared } = await import('../sageActions.js'));
});

// ─── Fake write tools ───────────────────────────────────────────────────────

let widgets;

const prepareClose = mock.fn(async ({ ids }) => {
  const targets = ids.map((id) => widgets.get(id)).filter((w) => w && w.open);
  if (!targets.length) return { ok: false, error: 'No open widgets match.' };
  return {
    ok: true,
    summary: {
      title: `Close ${targets.length} widgets`,
      lines: targets.map((t) => `Close ${t.name}`),
      targetCount: targets.length,
      targets: targets.map((t) => ({ id: t.id, name: t.name })),
      confirmLabel: 'Close widgets',
    },
    payload: { ids: targets.map((t) => t.id) },
  };
});
const commitClose = mock.fn(async (draft) => {
  for (const id of draft.payload.ids) widgets.get(id).open = false;
  return { ok: true, message: `Closed ${draft.payload.ids.length} widgets.`, details: { closed: draft.payload.ids } };
});

const closeWidgets = defineTool({
  name: 'close_widgets',
  domain: 'widgets',
  kind: 'write',
  description: 'Close widgets.',
  input: Joi.object({ ids: Joi.array().items(Joi.string()).min(1).max(50).required() }),
  access: { allOf: ['widgets.read', 'widgets.manage'] },
  prepare: prepareClose,
  commit: commitClose,
});

const preparePlan = mock.fn(async ({ project }) => ({
  ok: true,
  summary: { title: `Create 2 tasks in ${project}`, lines: ['Task A', 'Task B'], targetCount: 1, targets: [{ id: 'p1', name: project }] },
  payload: { projectId: 'p1', tasks: ['Task A', 'Task B'] },
}));
const recheckPlan = mock.fn(async () => ({ ok: true }));
const commitPlan = mock.fn(async (draft) => ({ ok: true, message: `Created ${draft.payload.tasks.length} tasks.` }));

const planTasks = defineTool({
  name: 'plan_tasks',
  domain: 'widgets',
  kind: 'write',
  description: 'Create a previewed task plan.',
  input: Joi.object({ project: Joi.string().required() }),
  access: { anyOf: ['widgets.manage'] },
  prepare: preparePlan,
  recheck: recheckPlan,
  commit: commitPlan,
});

const TOOLS = { close_widgets: closeWidgets, plan_tasks: planTasks };
const DOMAINS = [{ domain: 'widgets', summary: 'Widgets.', instructions: 'Widgets.', tools: [closeWidgets, planTasks] }];

const userWith = (id, ...perms) => ({ id, roleIds: [], authContext: { permissions: new Set(perms) } });
const owner = userWith('507f1f77bcf86cd799439011', 'widgets.read', 'widgets.manage');
const stranger = userWith('507f1f77bcf86cd799439012', 'widgets.read', 'widgets.manage');

let audits;
const createActivityLog = async (...args) => {
  audits.push(args);
  return {};
};
const req = { id: 'req-confirm' };
const deps = (extra = {}) => ({ findTool: async (name) => TOOLS[name] ?? null, createActivityLog, ...extra });
const minutesFromNow = (m) => () => new Date(Date.now() + m * 60 * 1000);

async function draft(name = 'close_widgets', args = { ids: ['w1', 'w2'] }, user = owner) {
  const registry = await getAgentTools(user, { domains: DOMAINS });
  const out = await registry.execute(name, args, { requestId: 'req-draft' });
  return { out, registry };
}

beforeEach(() => {
  rows.clear();
  claimSets.length = 0;
  audits = [];
  widgets = new Map([
    ['w1', { id: 'w1', name: 'Alpha', open: true }],
    ['w2', { id: 'w2', name: 'Beta', open: true }],
  ]);
  for (const fn of [FakeSageAction.create, prepareClose, commitClose, preparePlan, recheckPlan, commitPlan]) fn.mock.resetCalls();
});

// ─── Drafting in the loop ───────────────────────────────────────────────────

describe('write tool drafting (toolRegistry.execute)', () => {
  it('runs prepare, stores a pending draft and returns { draft, key, summary }; commit never runs', async () => {
    const before = Date.now();
    const { out, registry } = await draft();
    assert.equal(out.ok, true);
    assert.equal(out.result.draft, true);
    assert.match(out.result.key, /^[0-9a-f-]{36}$/);
    assert.equal(out.result.summary.targetCount, 2);
    assert.deepEqual(out.result.summary.targets, [{ id: 'w1', name: 'Alpha' }, { id: 'w2', name: 'Beta' }]);
    assert.equal(prepareClose.mock.callCount(), 1);
    assert.equal(commitClose.mock.callCount(), 0);

    const row = rows.get(out.result.key);
    assert.equal(row.status, 'pending');
    assert.equal(row.userId, owner.id);
    assert.equal(row.tool, 'close_widgets');
    assert.deepEqual(row.payload, { ids: ['w1', 'w2'] });
    assert.equal(row.requestId, 'req-draft');
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= 15 * 60 * 1000 - 1000 && ttl <= 15 * 60 * 1000 + 1000, `expiresAt ~15 min out (got ${ttl} ms)`);

    assert.deepEqual(registry.render('close_widgets', out.result), {
      blocks: [
        {
          type: 'confirm',
          key: out.result.key,
          title: 'Close 2 widgets',
          lines: ['Close Alpha', 'Close Beta'],
          targetCount: 2,
          confirmLabel: 'Close widgets',
          expiresAt: out.result.expiresAt,
        },
      ],
    });
  });

  it('a user with only one of the allOf permissions cannot draft', async () => {
    const { out } = await draft('close_widgets', { ids: ['w1'] }, userWith('507f1f77bcf86cd799439013', 'widgets.read'));
    assert.equal(out.ok, false);
    assert.match(out.error, /Requires all of: widgets\.read, widgets\.manage/);
    assert.equal(rows.size, 0);
  });

  it('prepare refusing, or over maxTargets, stores nothing', async () => {
    widgets.get('w1').open = false;
    widgets.get('w2').open = false;
    const { out } = await draft();
    assert.deepEqual(out, { ok: false, error: 'No open widgets match.' });
    assert.equal(rows.size, 0);

    const many = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
    const tool = { name: 'x', maxTargets: 2 };
    const over = checkPrepared(
      { ok: true, summary: { title: 'X', lines: [], targetCount: 3, targets: many }, payload: {} },
      tool
    );
    assert.equal(over.ok, false);
    assert.match(over.error, /at most 2/);
  });

  it('a malformed summary or a partial target list is refused', () => {
    const tool = { name: 'x', maxTargets: 50 };
    assert.equal(checkPrepared({ ok: true, summary: { lines: [], targetCount: 0, targets: [] }, payload: {} }, tool).ok, false);
    const partial = checkPrepared(
      { ok: true, summary: { title: 'X', lines: [], targetCount: 2, targets: [{ id: 'a', name: 'A' }] }, payload: {} },
      tool
    );
    assert.equal(partial.ok, false);
    assert.match(partial.error, /every target/);
  });
});

// ─── Confirm ────────────────────────────────────────────────────────────────

describe('confirmAction', () => {
  it('happy path: re-prepares, commits once with the draft payload, stores the result, audits once', async () => {
    const { out } = await draft();
    const { key } = out.result;
    const before = Date.now();
    const res = await confirmAction({ key, user: owner, req }, deps());

    assert.deepEqual(res, {
      code: 200,
      body: { status: 'done', message: 'Closed 2 widgets.', details: { closed: ['w1', 'w2'] } },
    });
    assert.equal(prepareClose.mock.callCount(), 2);
    assert.equal(commitClose.mock.callCount(), 1);
    assert.deepEqual(commitClose.mock.calls[0].arguments[0].payload, { ids: ['w1', 'w2'] });
    assert.equal(commitClose.mock.calls[0].arguments[1].requestId, 'req-confirm');

    const row = rows.get(key);
    assert.equal(row.status, 'done');
    assert.equal(claimSets[0].status, 'executing');
    assert.ok(claimSets[0].expiresAt.getTime() - before >= 24 * 60 * 60 * 1000 - 1000, 'claim bumps expiresAt to ~24 h');
    assert.ok(row.confirmedAt instanceof Date);
    assert.deepEqual(row.result, { ok: true, message: 'Closed 2 widgets.', details: { closed: ['w1', 'w2'] } });
    assert.ok(row.expiresAt.getTime() - before >= 24 * 60 * 60 * 1000 - 1000, 'expiresAt bumped to ~24 h');

    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0], [
      owner.id,
      'sage.action.confirmed',
      'SageAction',
      key,
      { source: 'sage', tool: 'close_widgets', targetCount: 2, targetIds: ['w1', 'w2'], outcome: 'done' },
      req,
    ]);
  });

  it('double confirm: concurrent and repeated confirms get 409, commit runs once', async () => {
    const { out } = await draft();
    const { key } = out.result;
    const [a, b] = await Promise.all([
      confirmAction({ key, user: owner, req }, deps()),
      confirmAction({ key, user: owner, req }, deps()),
    ]);
    assert.deepEqual([a.code, b.code].sort(), [200, 409]);
    const again = await confirmAction({ key, user: owner, req }, deps());
    assert.deepEqual(again, {
      code: 409,
      body: { status: 'done', message: 'Closed 2 widgets.', details: { closed: ['w1', 'w2'] } },
    });
    assert.equal(commitClose.mock.callCount(), 1);
    assert.equal(audits.length, 1);
  });

  it('expired draft → 410, marked expired, nothing runs', async () => {
    const { out } = await draft();
    const { key } = out.result;
    const res = await confirmAction({ key, user: owner, req }, deps({ now: minutesFromNow(16) }));
    assert.equal(res.code, 410);
    assert.equal(res.body.status, 'expired');
    assert.equal(rows.get(key).status, 'expired');
    assert.equal(commitClose.mock.callCount(), 0);
    assert.equal((await confirmAction({ key, user: owner, req }, deps())).code, 410);
  });

  it("another user's key → 404 and the draft stays pending; an unknown key → 404", async () => {
    const { out } = await draft();
    const { key } = out.result;
    const res = await confirmAction({ key, user: stranger, req }, deps());
    assert.equal(res.code, 404);
    assert.equal(rows.get(key).status, 'pending');
    assert.equal(
      (await confirmAction({ key: '00000000-0000-4000-8000-000000000000', user: owner, req }, deps())).code,
      404
    );
    assert.equal(commitClose.mock.callCount(), 0);
  });

  it('impersonating → 403 before any claim', async () => {
    const { out } = await draft();
    const { key } = out.result;
    const res = await confirmAction({ key, user: owner, impersonating: true, req }, deps());
    assert.deepEqual(res, { code: 403, body: { status: 'refused', message: 'Actions are disabled while impersonating' } });
    assert.equal(rows.get(key).status, 'pending');
    assert.equal(commitClose.mock.callCount(), 0);
  });

  it('permission revoked since the draft → 403, row failed, audited as failed', async () => {
    const { out } = await draft();
    const { key } = out.result;
    const revoked = userWith(owner.id, 'widgets.read');
    const res = await confirmAction({ key, user: revoked, req }, deps());
    assert.equal(res.code, 403);
    assert.equal(res.body.status, 'failed');
    assert.match(res.body.message, /Requires all of/);
    assert.equal(rows.get(key).status, 'failed');
    assert.equal(commitClose.mock.callCount(), 0);
    assert.equal(audits[0][1], 'sage.action.failed');
    assert.equal(audits[0][4].outcome, 'forbidden');
  });

  it('target set changed since the draft → 409 "data changed", never acts on the new set', async () => {
    const { out } = await draft();
    const { key } = out.result;
    widgets.get('w2').open = false;
    const res = await confirmAction({ key, user: owner, req }, deps());
    assert.deepEqual(res, {
      code: 409,
      body: { status: 'failed', message: 'The data changed since the draft — ask Sage again.' },
    });
    assert.equal(rows.get(key).status, 'failed');
    assert.equal(commitClose.mock.callCount(), 0);
    assert.equal(audits[0][4].outcome, 'stale');
  });

  it('commit throws → 500 { status: failed, message }, row failed (never left executing)', async () => {
    const { out } = await draft();
    const { key } = out.result;
    commitClose.mock.mockImplementationOnce(async () => {
      throw new Error('write failed');
    });
    const res = await confirmAction({ key, user: owner, req }, deps());
    assert.deepEqual(res, { code: 500, body: { status: 'failed', message: 'write failed' } });
    assert.equal(rows.get(key).status, 'failed');
    assert.deepEqual(rows.get(key).result, { ok: false, message: 'write failed' });
    assert.equal(audits[0][1], 'sage.action.failed');
    assert.equal(audits[0][4].outcome, 'error');
  });

  it('commit returning ok:false → status failed with its message', async () => {
    const { out } = await draft();
    commitClose.mock.mockImplementationOnce(async () => ({ ok: false, message: 'Widget Beta is locked.' }));
    const res = await confirmAction({ key: out.result.key, user: owner, req }, deps());
    assert.deepEqual(res, { code: 200, body: { status: 'failed', message: 'Widget Beta is locked.' } });
    assert.equal(rows.get(out.result.key).status, 'failed');
  });

  it('a failing audit write does not change the response', async () => {
    const { out } = await draft();
    const res = await confirmAction(
      { key: out.result.key, user: owner, req },
      deps({ createActivityLog: () => { throw new Error('audit down'); } })
    );
    assert.equal(res.code, 200);
    assert.equal(res.body.status, 'done');
  });

  it('recheck, when defined, replaces re-prepare: prepare is not called again on confirm', async () => {
    const { out } = await draft('plan_tasks', { project: 'Apollo' });
    assert.equal(preparePlan.mock.callCount(), 1);
    const res = await confirmAction({ key: out.result.key, user: owner, req }, deps());
    assert.deepEqual(res, { code: 200, body: { status: 'done', message: 'Created 2 tasks.' } });
    assert.equal(preparePlan.mock.callCount(), 1);
    assert.equal(recheckPlan.mock.callCount(), 1);
    assert.deepEqual(recheckPlan.mock.calls[0].arguments[0].payload, { projectId: 'p1', tasks: ['Task A', 'Task B'] });
    assert.equal(commitPlan.mock.callCount(), 1);
  });

  it('recheck returning ok:false fails the confirm with its error, commit never runs', async () => {
    const { out } = await draft('plan_tasks', { project: 'Apollo' });
    recheckPlan.mock.mockImplementationOnce(async () => ({ ok: false, error: 'The project was archived.' }));
    const res = await confirmAction({ key: out.result.key, user: owner, req }, deps());
    assert.deepEqual(res, { code: 409, body: { status: 'failed', message: 'The project was archived.' } });
    assert.equal(commitPlan.mock.callCount(), 0);
    assert.equal(preparePlan.mock.callCount(), 1);
  });
});

// ─── Cancel ─────────────────────────────────────────────────────────────────

describe('cancelAction', () => {
  it('cancel then confirm: cancel is idempotent, the confirm gets 409 and nothing runs', async () => {
    const { out } = await draft();
    const { key } = out.result;
    assert.deepEqual(await cancelAction({ key, user: owner }), { code: 200, body: { status: 'cancelled', message: 'Cancelled.' } });
    assert.deepEqual(await cancelAction({ key, user: owner }), { code: 200, body: { status: 'cancelled', message: 'Cancelled.' } });
    const res = await confirmAction({ key, user: owner, req }, deps());
    assert.equal(res.code, 409);
    assert.equal(res.body.status, 'cancelled');
    assert.equal(commitClose.mock.callCount(), 0);
  });

  it("another user cannot cancel someone else's draft (404); a done action cannot be cancelled (409)", async () => {
    const { out } = await draft();
    const { key } = out.result;
    assert.equal((await cancelAction({ key, user: stranger })).code, 404);
    assert.equal(rows.get(key).status, 'pending');
    await confirmAction({ key, user: owner, req }, deps());
    const res = await cancelAction({ key, user: owner });
    assert.equal(res.code, 409);
    assert.equal(res.body.status, 'done');
  });
});
