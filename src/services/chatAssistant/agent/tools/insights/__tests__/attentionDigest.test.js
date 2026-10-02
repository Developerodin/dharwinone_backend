import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getAttentionDigest from '../getAttentionDigest.tool.js';
import getOperationsSummary from '../getOperationsSummary.tool.js';
import insightsDomain from '../index.js';
import { DIGEST_ITEMS, OFFER_PENDING_DAYS } from '../digestItems.js';
import { previousWindow, resolveWindow, guardedSection, sectionFrom } from '../common.js';
import { SITUATIONS } from '../../../../../../constants/smartNudge.situations.js';

const UID = '64b0000000000000000000a1';
const viewer = (...perms) => ({ id: UID, _id: UID, name: 'Asha', authContext: { permissions: new Set(perms) } });
const NOW = new Date('2026-09-30T06:00:00.000Z'); // 11:30 IST, 30 Sep
const TODAY = '2026-09-30';

const ok = (result) => ({ status: 'ok', result });
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `Person ${i + 1}`, status: 'Pending', _id: `id${i}`, nested: { drop: 1 } }));
const list = (total, rows = Math.min(total, 3)) => ({ total, records: people(rows) });

function defaultResult(name, args) {
  if (name === 'get_attendance_summary') {
    return {
      window: args.window, total: 40,
      perDay: [{ date: args.window.from, counts: { Present: 30, Incomplete: 2 } }, { date: args.window.to, counts: { Incomplete: 1 } }],
      employees: people(3),
    };
  }
  if (name === 'get_allocation') return list(6);
  return list(4);
}

/** ctx.deps.runTool fake: per-tool override (outcome, or fn(args) → outcome); records every call. */
function ctxWith(overrides = {}, user = viewer('calls.view')) {
  const calls = [];
  const runTool = async (name, args, _ctx, opts) => {
    calls.push({ name, args, opts });
    const o = overrides[name];
    if (typeof o === 'function') return o(args);
    return o ?? ok(defaultResult(name, args));
  };
  return { ctx: { user, requestId: 'r', deps: { runTool, now: () => NOW } }, calls };
}

const item = (out, id) => out.items.find((i) => i.id === id);

describe('insights domain', () => {
  it('registers three read composites with a note access and a ≤15 s timeout', () => {
    assert.equal(insightsDomain.domain, 'insights');
    assert.ok(insightsDomain.summary.length <= 120 && !insightsDomain.summary.includes('\n'));
    assert.deepEqual(insightsDomain.tools.map((t) => t.name), ['get_attention_digest', 'get_operations_summary', 'run_data_quality_checks']);
    for (const t of insightsDomain.tools) {
      assert.equal(t.kind, 'read');
      assert.equal(t.domain, 'insights');
      assert.ok(t.access.note && !t.access.anyOf);
      assert.ok(t.timeoutMs <= 15000);
    }
  });
});

describe('get_attention_digest', () => {
  it('happy path: every item runs its tool with an explicit filter, top 3 rows, severity-sorted', async () => {
    const { ctx, calls } = ctxWith({ list_call_followups: (a) => ok(list(a.kind === 'callbackOverdue' ? 9 : 2)) });
    const out = await getAttentionDigest.execute({}, ctx);

    assert.equal(out.items.length, DIGEST_ITEMS.length);
    assert.deepEqual(out.window, { from: TODAY, to: TODAY });
    const byName = (n) => calls.filter((c) => c.name === n).map((c) => c.args);
    assert.deepEqual(byName('list_call_records')[0], { filters: { status: 'failed', calledBetween: { from: TODAY, to: TODAY } }, limit: 3 });
    assert.equal(byName('list_call_records')[0].filters.callType, undefined);
    assert.deepEqual(byName('list_call_followups').map((a) => a.kind).sort(), ['callbackOverdue', 'notYetCalled']);
    assert.deepEqual(byName('list_offers').map((a) => a.filters), [{ pendingOverDays: OFFER_PENDING_DAYS }, { acceptedNoPreboarding: true }]);
    assert.deepEqual(byName('list_interviews').map((a) => a.filters), [{ resultMissing: true }, { overlapping: true, scheduledBetween: { from: TODAY, to: TODAY } }]);
    const joining = byName('list_placements').find((a) => a.filters.stage === 'preBoarding');
    assert.deepEqual(joining.filters, { stage: 'preBoarding', status: 'Pending', joiningBetween: { from: TODAY, to: '2026-10-06' } });
    assert.deepEqual(byName('get_allocation')[0], { mode: 'list', bucket: 'projects_0', limit: 3 });
    assert.deepEqual(byName('list_tasks')[0], { filters: { overdue: true }, sort: 'dueDate', limit: 3 });
    assert.ok(calls.every((c) => c.opts.timeoutMs === 10000));

    const overdue = item(out, 'callbacks_overdue');
    assert.equal(overdue.status, 'ok');
    assert.equal(overdue.count, 9);
    assert.equal(overdue.rows.length, 3);
    assert.deepEqual(overdue.rows[0], { name: 'Person 1', status: 'Pending' });

    const ranks = { high: 0, medium: 1, low: 2 };
    const sev = out.items.map((i) => ranks[i.severity]);
    assert.deepEqual(sev, [...sev].sort((a, b) => a - b));
    assert.equal(out.items[0].id, 'callbacks_overdue');
    assert.deepEqual(out.restricted, []);
    assert.deepEqual(out.failed, []);
  });

  it('overdue courses are unavailable when no due date is stored, and call no tool', async () => {
    const { ctx, calls } = ctxWith();
    const out = await getAttentionDigest.execute({ module: 'hr' }, ctx);
    const courses = item(out, 'overdue_courses');
    assert.equal(courses.status, 'unavailable');
    assert.equal(courses.count, null);
    assert.match(courses.note, /no due date/);
    assert.match(courses.note, /not overdue/);
    assert.equal(getAttentionDigest.render(out).blocks[0].rows.find((r) => r.label === 'Overdue training courses').count, 'unavailable');
    assert.ok(!calls.some((c) => /training/.test(c.name)));
  });

  it('thresholds come from the smartNudge situations, and the 7-day offer default is said', async () => {
    const { ctx } = ctxWith();
    const out = await getAttentionDigest.execute({}, ctx);
    assert.match(item(out, 'interviews_no_result').nudge, new RegExp(`${SITUATIONS.result_overdue.hoursAfterConclusion} h`));
    assert.match(item(out, 'pending_leave').nudge, new RegExp(`${SITUATIONS.leave_pending_stale.staleDays} days`));
    assert.match(item(out, 'offers_unanswered').label, /7 days/);
    assert.match(item(out, 'offers_unanswered').nudge, /Default 7 days/);
  });

  it('maps every section status: restricted, denial-in-result, timeout, error, unknown, notRecorded', async () => {
    const { ctx } = ctxWith({
      list_call_records: { status: 'restricted', reason: 'Requires one of: calls.view.' },
      list_call_followups: ok({ forbidden: true, error: 'Needs candidates.read' }),
      list_interviews: { status: 'timeout' },
      list_offers: ok({ error: 'Requires one of: offers.read.' }),
      list_placements: ok({ error: 'boom' }),
      list_tasks: { status: 'unknown', error: 'unknown tool' },
      get_attendance_summary: ok({ futureDate: true, note: 'That day has not happened yet.' }),
    });
    const out = await getAttentionDigest.execute({}, ctx);

    const failed = item(out, 'failed_calls');
    assert.deepEqual(Object.keys(failed).sort(), ['id', 'label', 'module', 'severity', 'source', 'status']);
    assert.equal(failed.status, 'restricted');
    assert.equal(item(out, 'callbacks_overdue').status, 'restricted');
    assert.equal(item(out, 'offers_unanswered').status, 'restricted');
    assert.equal(item(out, 'panel_clashes').status, 'timeout');
    assert.equal(item(out, 'join_date_passed').status, 'error');
    assert.equal(item(out, 'join_date_passed').error, 'boom');
    assert.equal(item(out, 'overdue_tasks').status, 'error');
    const punches = item(out, 'incomplete_punches');
    assert.equal(punches.status, 'notRecorded');
    assert.equal(punches.count, null);
    assert.deepEqual(punches.rows, []);

    assert.ok(out.restricted.includes('Failed calls'));
    assert.ok(out.failed.some((f) => f.label === 'Overdue tasks' && f.status === 'error'));
    assert.ok(out.failed.some((f) => f.status === 'timeout'));
    for (const i of out.items.filter((x) => x.status !== 'ok')) assert.ok(!i.rows?.length);
  });

  it('empty sets give 0 with no rows; incomplete punches sum every day in the window', async () => {
    const { ctx } = ctxWith({
      list_call_followups: ok({ total: 0, records: [] }),
      get_attendance_summary: (a) => ok({
        window: a.window, total: 5, perDay: [{ counts: { Incomplete: 2 } }, { counts: {} }, { counts: { Incomplete: 3 } }], employees: [],
      }),
    });
    const out = await getAttentionDigest.execute({ window: { from: '2026-09-28', to: '2026-09-30' } }, ctx);
    assert.equal(item(out, 'never_called').count, 0);
    assert.deepEqual(item(out, 'never_called').rows, []);
    assert.equal(item(out, 'incomplete_punches').count, 5);
  });

  it('incomplete punches never count today (everyone on shift is Incomplete until they punch out)', async () => {
    const windows = [];
    const { ctx } = ctxWith({
      get_attendance_summary: (a) => { windows.push(a.window); return ok({ window: a.window, total: 0, perDay: [], employees: [] }); },
    });
    await getAttentionDigest.execute({ window: { from: '2026-09-28', to: '2026-09-30' } }, ctx);
    await getAttentionDigest.execute({}, ctx);
    assert.deepEqual(windows, [{ from: '2026-09-28', to: '2026-09-29' }, { from: '2026-09-29', to: '2026-09-29' }]);
  });

  it('duplicate names in the rows are kept as separate rows (no merging)', async () => {
    const twins = { total: 2, records: [{ name: 'Ravi Kumar', status: 'Pending' }, { name: 'Ravi Kumar', status: 'Pending' }] };
    const { ctx } = ctxWith({ list_leave_requests: ok(twins) });
    const out = await getAttentionDigest.execute({ module: 'hr' }, ctx);
    assert.equal(item(out, 'pending_leave').rows.length, 2);
  });

  it("scope 'mine' passes each tool's own mine filter and lists the rest as notScopedToYou", async () => {
    const { ctx, calls } = ctxWith();
    const out = await getAttentionDigest.execute({ scope: 'mine' }, ctx);
    assert.deepEqual(calls.map((c) => c.name).sort(), ['list_backdated_requests', 'list_call_records', 'list_leave_requests', 'list_tasks']);
    const args = Object.fromEntries(calls.map((c) => [c.name, c.args.filters]));
    assert.equal(args.list_call_records.mine, true);
    // Pending approvals: no `mine`; the page scope gives a reviewer what awaits them, others their own.
    assert.equal(args.list_leave_requests.mine, undefined);
    assert.equal(args.list_backdated_requests.mine, undefined);
    assert.equal(args.list_tasks.assignedToMe, true);
    assert.ok(out.notScopedToYou.includes('Callbacks overdue'));
    assert.ok(out.notScopedToYou.includes('Employees on no active project'));
    assert.ok(!out.notScopedToYou.includes('Overdue training courses'));
    assert.equal(item(out, 'overdue_courses').status, 'unavailable');
    assert.equal(item(out, 'overdue_courses').count, null);
  });

  it("compareTo 'previous' re-runs only windowed items for the previous equal window → { now, before, delta }", async () => {
    const { ctx, calls } = ctxWith({
      list_call_records: (a) => ok(list(a.filters.calledBetween.from === '2026-09-01' ? 10 : 4, 1)),
      list_interviews: (a) => (a.filters.scheduledBetween?.from === '2026-08-02' ? { status: 'timeout' } : ok(list(1))),
    });
    const out = await getAttentionDigest.execute({ window: { from: '2026-09-01', to: '2026-09-30' }, compareTo: 'previous' }, ctx);

    assert.deepEqual(out.previousWindow, { from: '2026-08-02', to: '2026-08-31' });
    assert.deepEqual(item(out, 'failed_calls').compare, { now: 10, before: 4, delta: 6 });
    assert.deepEqual(item(out, 'incomplete_punches').compare, { now: 3, before: 3, delta: 0 });
    const clashes = item(out, 'panel_clashes').compare;
    assert.equal(clashes.before, null);
    assert.equal(clashes.beforeStatus, 'timeout');
    assert.ok(out.noWindow.includes('Callbacks overdue'));
    assert.ok(!out.noWindow.includes('Failed calls'));
    assert.equal(item(out, 'callbacks_overdue').compare, undefined);
    const before = calls.filter((c) => c.args.window?.from === '2026-08-02' || c.args.filters?.calledBetween?.from === '2026-08-02');
    assert.ok(before.length >= 2);
    assert.ok(before.filter((c) => c.args.limit !== undefined).every((c) => c.args.limit === 1));
  });

  it('module filter keeps only that module; an invalid or reversed window throws', async () => {
    const { ctx, calls } = ctxWith();
    const out = await getAttentionDigest.execute({ module: 'pm' }, ctx);
    assert.deepEqual(out.items.map((i) => i.id), ['overdue_tasks']);
    assert.deepEqual(calls.map((c) => c.name), ['list_tasks']);
    await assert.rejects(getAttentionDigest.execute({ window: { from: '2026-09-30', to: '2026-09-01' } }, ctx));
    await assert.rejects(getAttentionDigest.execute({ window: { from: '2026-02-30' } }, ctx));
  });

  it('input schema rejects unknown scope / module / compareTo', () => {
    assert.ok(getAttentionDigest.input.validate({ scope: 'team' }).error);
    assert.ok(getAttentionDigest.input.validate({ module: 'sales' }).error);
    assert.ok(getAttentionDigest.input.validate({ compareTo: 'lastYear' }).error);
    assert.equal(getAttentionDigest.input.validate({}).value.scope, 'all');
  });

  it('render: one table, status words for non-ok items, a Change column only when comparing', async () => {
    const { ctx } = ctxWith({ list_tasks: { status: 'restricted' } });
    const out = await getAttentionDigest.execute({ module: 'pm' }, ctx);
    const block = getAttentionDigest.render(out).blocks[0];
    assert.equal(block.type, 'table');
    assert.deepEqual(block.rows, [{ label: 'Overdue tasks', severity: 'medium', count: 'restricted' }]);
    assert.ok(!block.columns.some((c) => c.key === 'delta'));
    assert.equal(getAttentionDigest.render({ items: [] }), null);
  });
});

describe('get_operations_summary', () => {
  it('recruitment: key counts via count tools with the window, plus the recruitment digest items', async () => {
    const { ctx, calls } = ctxWith({
      count_jobs: ok({ total: 12 }),
      count_applications: ok({ total: 340, breakdown: { Applied: 300 } }),
      count_interviews: ok({ total: 8 }),
      count_offers: ok({ total: 3, byStatus: { Sent: 2 } }),
      count_placements: ok({ total: 2 }),
    });
    const w = { from: '2026-09-01', to: '2026-09-30' };
    const out = await getOperationsSummary.execute({ module: 'recruitment', window: w }, ctx);
    const m = Object.fromEntries(out.metrics.map((x) => [x.id, x]));
    assert.equal(m.open_jobs.value, 12);
    assert.equal(m.applications.value, 340);
    assert.match(m.applications.note, /no date window/);
    assert.equal(m.interviews.value, 8);
    assert.equal(m.joiners.value, 2);
    const args = Object.fromEntries(calls.filter((c) => c.name.startsWith('count_')).map((c) => [c.name, c.args]));
    assert.deepEqual(args.count_interviews, { filters: { scheduledBetween: w } });
    assert.deepEqual(args.count_offers, { filters: { createdBetween: w } });
    assert.deepEqual(args.count_placements, { filters: { status: 'Joined', joiningBetween: w } });
    assert.ok(out.attention.length > 0 && out.attention.every((i) => i.module === 'recruitment'));
  });

  it('hr: present today from the attendance summary; a restricted metric shows its name only', async () => {
    const { ctx } = ctxWith({
      count_employees: { status: 'restricted' },
      who_is_on_leave_today: ok({ total: 4, records: [] }),
      count_placements: ok({ total: 5 }),
    });
    const out = await getOperationsSummary.execute({ module: 'hr' }, ctx);
    const m = Object.fromEntries(out.metrics.map((x) => [x.id, x]));
    assert.deepEqual(m.employees, { id: 'employees', label: 'Current employees', source: 'count_employees', status: 'restricted' });
    assert.equal(m.present_today.value, 32, 'Present + Incomplete (on shift, not yet punched out)');
    assert.equal(m.on_leave_today.value, 4);
    assert.ok(out.restricted.includes('Current employees'));
  });

  it('pm: open tasks = total − completed, with overdue / blocked; utilisation buckets', async () => {
    const { ctx } = ctxWith({
      count_projects: ok({ total: 7, scope: 'all', groups: [{ value: 'Active', count: 5 }, { value: 'Completed', count: 2 }] }),
      count_tasks: ok({ total: 50, overdue: 6, blocked: 2, scope: 'all', groups: [{ value: 'todo', count: 20 }, { value: 'completed', count: 30 }] }),
      get_allocation: ok({ total: 40, byActiveProjects: { 0: 10, 1: 20, 2: 9, '3+': 1 }, atOrOverLimit: 10, unallocated: 8, overloaded: 1 }),
    });
    const out = await getOperationsSummary.execute({ module: 'pm' }, ctx);
    const m = Object.fromEntries(out.metrics.map((x) => [x.id, x]));
    assert.equal(m.projects.value, 7);
    assert.deepEqual(m.projects.detail.byStatus, { Active: 5, Completed: 2 });
    assert.equal(m.open_tasks.value, 20);
    assert.equal(m.open_tasks.detail.overdue, 6);
    assert.equal(m.utilisation.detail.byActiveProjects['3+'], 1);
  });

  it('bench: employees on no project + external jobs; an errored count goes to failed', async () => {
    const { ctx, calls } = ctxWith({
      get_allocation: (a) => (a.mode === 'summary' ? ok({ total: 40, byActiveProjects: { 0: 10 }, unallocated: 8 }) : ok(list(10))),
      count_jobs: { status: 'error', error: 'db down' },
    });
    const out = await getOperationsSummary.execute({ module: 'bench' }, ctx);
    const m = Object.fromEntries(out.metrics.map((x) => [x.id, x]));
    assert.equal(m.unallocated.value, 10);
    assert.equal(m.external_jobs.status, 'error');
    assert.deepEqual(calls.find((c) => c.name === 'count_jobs').args, { filters: { jobOrigin: 'external' } });
    assert.ok(out.failed.some((f) => f.label === 'External jobs (Active)'));
    assert.deepEqual(out.attention.map((i) => i.id), ['employees_no_project']);
  });

  it('module is required and must be one of the four', () => {
    assert.ok(getOperationsSummary.input.validate({}).error);
    assert.ok(getOperationsSummary.input.validate({ module: 'all' }).error);
    assert.ok(!getOperationsSummary.input.validate({ module: 'hr' }).error);
  });

  it('render lists metrics then attention items', async () => {
    const { ctx } = ctxWith();
    const out = await getOperationsSummary.execute({ module: 'pm' }, ctx);
    const rows = getOperationsSummary.render(out).blocks[0].rows;
    assert.equal(rows.length, out.metrics.length + out.attention.length);
  });
});

describe('insights common helpers', () => {
  it('previousWindow: one day → the day before; a month → the equal span before it', () => {
    assert.deepEqual(previousWindow({ from: TODAY, to: TODAY }), { from: '2026-09-29', to: '2026-09-29' });
    assert.deepEqual(previousWindow({ from: '2026-09-01', to: '2026-09-07' }), { from: '2026-08-25', to: '2026-08-31' });
  });

  it('resolveWindow defaults to today in IST and fills a one-sided window', () => {
    assert.deepEqual(resolveWindow(undefined, new Date('2026-09-30T20:00:00.000Z')), { from: '2026-10-01', to: '2026-10-01' });
    assert.deepEqual(resolveWindow({ from: '2026-09-10' }, NOW), { from: '2026-09-10', to: '2026-09-10' });
  });

  it('guardedSection turns a throw into error and a slow section into timeout', async () => {
    assert.deepEqual(await guardedSection(async () => { throw new Error('bad'); }), { status: 'error', error: 'bad' });
    assert.deepEqual(await guardedSection(() => new Promise((r) => setTimeout(r, 200)), 10), { status: 'timeout' });
  });

  it('sectionFrom: a missing outcome is restricted, never data', () => {
    assert.deepEqual(sectionFrom(undefined, () => ({ count: 1 })), { status: 'restricted' });
    assert.deepEqual(sectionFrom(ok(null), () => ({ count: 1 })), { status: 'error', error: 'empty result' });
  });
});
