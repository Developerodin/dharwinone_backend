import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import ApiError from '../../../../../../../utils/ApiError.js';

// In-memory SageAction: every write in this file lands here, never in Mongo.
const rows = new Map();
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
const chain = (fn) => ({ lean: async () => structuredClone(fn()) });
const FakeSageAction = {
  create: async (doc) => {
    rows.set(doc.key, structuredClone(doc));
    return doc;
  },
  findOne: (filter) => chain(() => find(filter)),
  findOneAndUpdate: (filter, update) =>
    chain(() => {
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

let tool;
let OWNER_ONLY_MESSAGE;
let PM_OFF_MESSAGE;
let createDraft;
let confirmAction;
let checkAccessRule;

before(async () => {
  mock.module('../../../../../../../models/sageAction.model.js', {
    defaultExport: FakeSageAction,
    namedExports: { SAGE_ACTION_STATUSES: ['pending', 'executing', 'done', 'failed', 'cancelled', 'expired'] },
  });
  ({ default: tool, OWNER_ONLY_MESSAGE, PM_OFF_MESSAGE } = await import('../createTaskPlan.tool.js'));
  ({ createDraft, confirmAction } = await import('../../../../sageActions.js'));
  ({ checkAccessRule } = await import('../../../../../toolAccess.js'));
});

const PROJECT_ID = '64b000000000000000000001';
const USER_ID = '507f1f77bcf86cd799439011';
const PREVIEW_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const userWith = (id, ...perms) => ({ id, roleIds: [], authContext: { permissions: new Set(perms) } });
const planner = userWith(USER_ID, 'projects.manage', 'tasks.manage');
const taskList = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}`, status: 'new' }));

let snap;
let preview;
let apply;
let deps;
const ctx = (user = planner) => ({ user, requestId: 'req-1', deps });

beforeEach(() => {
  rows.clear();
  snap = {
    previewId: PREVIEW_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    state: 'open',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  preview = mock.fn(async () => ({ previewId: PREVIEW_ID, tasks: taskList(3) }));
  apply = mock.fn(async (_projectId, _user, { tasks }) => ({ createdCount: tasks.length, tasks: [] }));
  deps = {
    resolveProject: mock.fn(async () => ({ kind: 'found', project: { _id: PROJECT_ID, name: 'Apollo' } })),
    previewTaskBreakdown: preview,
    applyTaskBreakdown: apply,
    TaskBreakdownPreview: {
      findOne: mock.fn(() => ({ select: () => ({ lean: async () => (snap ? { ...snap } : null) }) })),
    },
    createActivityLog: async () => ({}),
    findTool: async () => tool,
  };
});

const draftFrom = (prepared, key = 'sage-key-1') => ({
  key,
  tool: tool.name,
  args: { project: 'Apollo' },
  summary: prepared.summary,
  payload: prepared.payload,
});

describe('create_task_plan prepare', () => {
  it('drafts the preview: task titles as lines, the project as the target, ids in the payload', async () => {
    const prepared = await tool.prepare({ project: 'apollo', brief: 'focus on QA' }, ctx());
    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.summary, {
      title: 'Create 3 tasks in Apollo',
      lines: ['Task 1', 'Task 2', 'Task 3'],
      targetCount: 1,
      targets: [{ id: PROJECT_ID, name: 'Apollo' }],
      confirmLabel: 'Create tasks',
    });
    assert.deepEqual(prepared.payload, { projectId: PROJECT_ID, previewId: PREVIEW_ID, tasks: taskList(3) });
    assert.equal(preview.mock.callCount(), 1);
    assert.deepEqual(preview.mock.calls[0].arguments, [PROJECT_ID, planner, { extraBrief: 'focus on QA' }]);
    assert.deepEqual(deps.resolveProject.mock.calls[0].arguments, ['apollo', planner]);
  });

  it('caps each title in the summary at 60 characters', async () => {
    const long = 'x'.repeat(80);
    preview = mock.fn(async () => ({ previewId: PREVIEW_ID, tasks: [{ id: 't0', title: long }] }));
    deps.previewTaskBreakdown = preview;
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.equal(prepared.summary.lines[0].length, 60);
    assert.ok(prepared.summary.lines[0].endsWith('…'));
    assert.equal(prepared.payload.tasks[0].title, long, 'the payload keeps the full task');
  });

  it('refuses a project the viewer cannot see by the typed name only, before any preview', async () => {
    deps.resolveProject = mock.fn(async () => ({ kind: 'notFound' }));
    const prepared = await tool.prepare({ project: 'Secret Project' }, ctx());
    assert.deepEqual(prepared, { ok: false, error: 'No project you can see matches "Secret Project".' });
    assert.equal(preview.mock.callCount(), 0);
  });

  it('asks which project when the name is ambiguous, before any preview', async () => {
    deps.resolveProject = mock.fn(async () => ({
      kind: 'ambiguous',
      matches: [{ _id: 'a', name: 'Apollo Web' }, { _id: 'b', name: 'Apollo App' }],
    }));
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /"Apollo Web", "Apollo App"/);
    assert.equal(preview.mock.callCount(), 0);
  });

  it('trap: not the project creator or an admin → a refusal, not a crash, and no draft row', async () => {
    deps.previewTaskBreakdown = mock.fn(async () => {
      throw new ApiError(403, 'Forbidden');
    });
    assert.deepEqual(await tool.prepare({ project: 'Apollo' }, ctx()), { ok: false, error: OWNER_ONLY_MESSAGE });
    const drafted = await createDraft(tool, { project: 'Apollo' }, ctx());
    assert.deepEqual(drafted, { ok: false, error: OWNER_ONLY_MESSAGE });
    assert.equal(rows.size, 0);
  });

  it('trap: PM assistant disabled (404) → "the PM assistant is turned off"', async () => {
    deps.previewTaskBreakdown = mock.fn(async () => {
      throw new ApiError(404, 'PM assistant is disabled (PM_ASSISTANT_ENABLED=false).');
    });
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.deepEqual(prepared, { ok: false, error: PM_OFF_MESSAGE });
    assert.match(PM_OFF_MESSAGE, /the PM assistant is turned off/i);
  });

  it('trap: the preview is an LLM call → timeoutMs is 15000', () => {
    assert.equal(tool.timeoutMs, 15000);
  });

  it('refuses more than 60 tasks (the apply route cap) and accepts exactly 60', async () => {
    deps.previewTaskBreakdown = mock.fn(async () => ({ previewId: PREVIEW_ID, tasks: taskList(61) }));
    const tooMany = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /61 tasks; at most 60/);

    deps.previewTaskBreakdown = mock.fn(async () => ({ previewId: PREVIEW_ID, tasks: taskList(60) }));
    const sixty = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.equal(sixty.ok, true);
    assert.equal(sixty.summary.lines.length, 60);
  });

  it('refuses an empty plan', async () => {
    deps.previewTaskBreakdown = mock.fn(async () => ({ previewId: PREVIEW_ID, tasks: [] }));
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    assert.deepEqual(prepared, { ok: false, error: 'The PM assistant suggested no new tasks for Apollo.' });
  });
});

describe('create_task_plan access', () => {
  it('needs both projects.manage AND tasks.manage; platformSuperUser passes', async () => {
    assert.deepEqual(tool.access, { allOf: ['projects.manage', 'tasks.manage'] });
    assert.equal((await checkAccessRule(tool.access, planner)).ok, true);
    assert.equal((await checkAccessRule(tool.access, userWith(USER_ID, 'projects.manage'))).ok, false);
    assert.equal((await checkAccessRule(tool.access, userWith(USER_ID, 'tasks.manage'))).ok, false);
    assert.equal((await checkAccessRule(tool.access, userWith(USER_ID, 'projects.read'))).ok, false);
    assert.equal((await checkAccessRule(tool.access, { id: USER_ID, platformSuperUser: true })).ok, true);
  });
});

describe('create_task_plan commit', () => {
  it('calls applyTaskBreakdown with exactly the payload ids/tasks and the SageAction key', async () => {
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    const result = await tool.commit(draftFrom(prepared), ctx());
    assert.deepEqual(result, {
      ok: true,
      message: 'Created 3 tasks in Apollo.',
      details: { projectId: PROJECT_ID, createdCount: 3 },
    });
    assert.equal(apply.mock.callCount(), 1);
    assert.deepEqual(apply.mock.calls[0].arguments, [
      PROJECT_ID,
      planner,
      { tasks: taskList(3), previewId: PREVIEW_ID, idempotencyKey: 'sage-key-1' },
    ]);
  });

  it('replay passes the same idempotency key, so the service returns the stored response', async () => {
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    await tool.commit(draftFrom(prepared), ctx());
    await tool.commit(draftFrom(prepared), ctx());
    assert.equal(apply.mock.callCount(), 2);
    assert.deepEqual(
      apply.mock.calls.map((c) => c.arguments[2].idempotencyKey),
      ['sage-key-1', 'sage-key-1']
    );
  });

  it('turns a service refusal into a failed result instead of a crash', async () => {
    const prepared = await tool.prepare({ project: 'Apollo' }, ctx());
    deps.applyTaskBreakdown = mock.fn(async () => {
      throw new ApiError(400, 'One or more titles already exist on this project');
    });
    assert.deepEqual(await tool.commit(draftFrom(prepared), ctx()), {
      ok: false,
      message: 'One or more titles already exist on this project',
    });
    deps.applyTaskBreakdown = mock.fn(async () => {
      throw new ApiError(403, 'Forbidden');
    });
    assert.deepEqual(await tool.commit(draftFrom(prepared), ctx()), { ok: false, message: OWNER_ONLY_MESSAGE });
  });
});

describe('create_task_plan recheck', () => {
  const draft = () => ({ key: 'k', payload: { projectId: PROJECT_ID, previewId: PREVIEW_ID, tasks: taskList(3) } });

  it('passes for the open preview of this project and user without calling the preview again', async () => {
    assert.deepEqual(await tool.recheck(draft(), ctx()), { ok: true });
    assert.equal(preview.mock.callCount(), 0);
  });

  it('refuses an applied or superseded preview', async () => {
    for (const state of ['applied', 'superseded']) {
      snap.state = state;
      // eslint-disable-next-line no-await-in-loop
      const checked = await tool.recheck(draft(), ctx());
      assert.equal(checked.ok, false);
      assert.match(checked.error, /already applied or replaced/);
    }
    assert.equal(preview.mock.callCount(), 0);
  });

  it('refuses a missing, expired, other-project or other-user preview', async () => {
    const cases = [
      () => { snap = null; },
      () => { snap.expiresAt = new Date(Date.now() - 1000); },
      () => { snap.projectId = '64b000000000000000000999'; },
      () => { snap.userId = '507f1f77bcf86cd799439099'; },
    ];
    for (const change of cases) {
      snap = { previewId: PREVIEW_ID, projectId: PROJECT_ID, userId: USER_ID, state: 'open', expiresAt: new Date(Date.now() + 60000) };
      change();
      // eslint-disable-next-line no-await-in-loop
      const checked = await tool.recheck(draft(), ctx());
      assert.equal(checked.ok, false);
    }
    assert.equal(preview.mock.callCount(), 0);
  });
});

describe('create_task_plan through draft and confirm', () => {
  it('confirm uses recheck, passes the SageAction key into apply, and a second confirm is refused', async () => {
    const drafted = await createDraft(tool, { project: 'Apollo' }, ctx());
    assert.equal(drafted.ok, true);
    const { key } = drafted.result;
    assert.equal(rows.get(key).status, 'pending');

    const first = await confirmAction({ key, user: planner }, deps);
    assert.equal(first.code, 200);
    assert.equal(first.body.status, 'done');
    assert.equal(preview.mock.callCount(), 1, 'only the draft ran the preview');
    assert.equal(apply.mock.callCount(), 1);
    assert.deepEqual(apply.mock.calls[0].arguments[2], { tasks: taskList(3), previewId: PREVIEW_ID, idempotencyKey: key });

    const second = await confirmAction({ key, user: planner }, deps);
    assert.equal(second.code, 409);
    assert.equal(apply.mock.callCount(), 1);
  });

  it('a superseded preview fails the confirm without applying', async () => {
    const drafted = await createDraft(tool, { project: 'Apollo' }, ctx());
    snap.state = 'superseded';
    const res = await confirmAction({ key: drafted.result.key, user: planner }, deps);
    assert.equal(res.body.status, 'failed');
    assert.equal(apply.mock.callCount(), 0);
  });

  it('lost permissions at confirm → 403 without applying', async () => {
    const drafted = await createDraft(tool, { project: 'Apollo' }, ctx());
    const demoted = userWith(USER_ID, 'projects.manage');
    const res = await confirmAction({ key: drafted.result.key, user: demoted }, deps);
    assert.equal(res.code, 403);
    assert.equal(apply.mock.callCount(), 0);
  });
});
