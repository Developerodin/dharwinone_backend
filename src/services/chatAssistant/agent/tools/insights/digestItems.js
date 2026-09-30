import { addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { SITUATIONS } from '../../../../../constants/smartNudge.situations.js';
import {
  SECTION_TIMEOUT_MS, istToday, resolveWindow, previousWindow, runSections, sectionFrom, trimRows,
} from './common.js';

export const MODULES = ['recruitment', 'hr', 'pm', 'bench'];
export const TOP_ROWS = 3;
// The brief's default for "offers unanswered"; the admin nudge (offer_aging) uses its own, shorter threshold.
export const OFFER_PENDING_DAYS = 7;
const JOINING_AHEAD_DAYS = 7;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

const listPick = (r) => ({
  count: r.total ?? null,
  rows: r.records ?? [],
  ...(r.sentDateMissing ? { sentDateMissing: r.sentDateMissing } : {}),
});

const PENDING_NOTE = 'Reviewers see every pending request (what awaits approval); everyone else sees their own.';

/** The window cut to end yesterday; a window lying wholly in today becomes yesterday. */
function throughYesterday(window, today) {
  const yesterday = addDaysToDateStr(today, -1);
  const to = window.to < today ? window.to : yesterday;
  return { from: window.from <= to ? window.from : to, to };
}

function incompletePunchesPick(r) {
  if (r.futureDate) return { status: 'notRecorded', count: null, rows: [], note: r.note };
  const count = (r.perDay || []).reduce((n, d) => n + (d.counts?.Incomplete ?? 0), 0);
  return { count, rows: r.employees ?? [] };
}

/**
 * The digest's fixed item table. Every item with a `tool` is one runTool call with an explicit filter;
 * `mine` = the tool has its own "only mine" filter (scope 'mine' keeps it); `windowed` = the window
 * changes its count (compareTo 'previous' can re-run it). Severity is fixed here, not computed.
 */
export const DIGEST_ITEMS = Object.freeze([
  {
    id: 'failed_calls', label: 'Failed calls', module: 'recruitment', severity: 'medium',
    tool: 'list_call_records', mine: true, windowed: true,
    args: ({ window, mine, limit }) => ({ filters: { status: 'failed', calledBetween: window, ...(mine ? { mine: true } : {}) }, limit }),
    note: 'AI agent and dialer calls: most call records carry no call type, so this is not narrowed to AI calls.',
  },
  {
    id: 'callbacks_overdue', label: 'Callbacks overdue', module: 'recruitment', severity: 'high',
    tool: 'list_call_followups', args: ({ limit }) => ({ kind: 'callbackOverdue', limit }),
  },
  {
    id: 'never_called', label: 'Applicants never called', module: 'recruitment', severity: 'medium',
    tool: 'list_call_followups', args: ({ limit }) => ({ kind: 'notYetCalled', limit }),
  },
  {
    id: 'interviews_no_result', label: 'Interviews ended without a result', module: 'recruitment', severity: 'medium',
    tool: 'list_interviews', args: ({ limit }) => ({ filters: { resultMissing: true }, limit }),
    nudge: `The result-overdue nudge fires ${SITUATIONS.result_overdue.hoursAfterConclusion} h after an interview ends.`,
  },
  {
    id: 'panel_clashes', label: 'Interview panel clashes', module: 'recruitment', severity: 'high',
    tool: 'list_interviews', windowed: true,
    args: ({ window, limit }) => ({ filters: { overlapping: true, scheduledBetween: window }, limit }),
  },
  {
    id: 'offers_unanswered', label: `Offers unanswered over ${OFFER_PENDING_DAYS} days`, module: 'recruitment', severity: 'medium',
    tool: 'list_offers', args: ({ limit }) => ({ filters: { pendingOverDays: OFFER_PENDING_DAYS }, limit }),
    nudge: `Default ${OFFER_PENDING_DAYS} days since the offer was marked Sent; the offer-aging nudge reminds ` +
      `recruiters after ${SITUATIONS.offer_aging.recruiterDays} days.`,
  },
  {
    id: 'accepted_no_preboarding', label: 'Accepted offers, pre-boarding not started', module: 'hr', severity: 'medium',
    tool: 'list_offers', args: ({ limit }) => ({ filters: { acceptedNoPreboarding: true }, limit }),
  },
  {
    id: 'joining_soon_preboarding', label: `Joining in the next ${JOINING_AHEAD_DAYS} days, still in pre-boarding`,
    module: 'hr', severity: 'high', tool: 'list_placements',
    args: ({ today, limit }) => ({
      filters: {
        stage: 'preBoarding', status: 'Pending',
        joiningBetween: { from: today, to: addDaysToDateStr(today, JOINING_AHEAD_DAYS - 1) },
      },
      limit,
    }),
    nudge: `The pre-boarding nudge fires ${SITUATIONS.preboard_incomplete.daysBeforeJoin} days before joining.`,
  },
  {
    id: 'join_date_passed', label: 'Joining date passed, not onboarded', module: 'hr', severity: 'high',
    tool: 'list_placements', args: ({ limit }) => ({ filters: { joinDatePassedNotOnboarded: true }, limit }),
  },
  {
    id: 'ready_for_bgv', label: 'Ready for background verification', module: 'hr', severity: 'low',
    tool: 'list_placements', args: ({ limit }) => ({ filters: { readyForBgv: true }, limit }),
  },
  {
    id: 'incomplete_punches', label: 'Incomplete punches (days already over)', module: 'hr', severity: 'low',
    tool: 'get_attendance_summary', windowed: true,
    // Today everyone still on shift is Incomplete, so the window stops at yesterday (a today-only window reads yesterday).
    args: ({ window, today }) => ({ window: throughYesterday(window, today), status: 'Incomplete' }), pick: incompletePunchesPick,
  },
  {
    id: 'pending_leave', label: 'Pending leave requests', module: 'hr', severity: 'medium',
    tool: 'list_leave_requests', mine: true, note: PENDING_NOTE,
    // No `mine` filter even in scope 'mine': the page's own scope already gives reviewers the requests awaiting
    // them and everyone else their own; `mine` would show a reviewer only what they filed themselves.
    args: ({ limit }) => ({ filters: { status: 'pending' }, limit }),
    nudge: `The leave nudge flags requests pending over ${SITUATIONS.leave_pending_stale.staleDays} days.`,
  },
  {
    id: 'pending_backdated', label: 'Pending backdated attendance requests', module: 'hr', severity: 'low',
    tool: 'list_backdated_requests', mine: true, note: PENDING_NOTE,
    args: ({ limit }) => ({ filters: { status: 'pending' }, limit }),
  },
  {
    id: 'overdue_tasks', label: 'Overdue tasks', module: 'pm', severity: 'medium',
    tool: 'list_tasks', mine: true,
    args: ({ mine, limit }) => ({ filters: { overdue: true, ...(mine ? { assignedToMe: true } : {}) }, sort: 'dueDate', limit }),
  },
  {
    id: 'employees_no_project', label: 'Employees on no active project', module: 'bench', severity: 'low',
    tool: 'get_allocation', args: ({ limit }) => ({ mode: 'list', bucket: 'projects_0', limit }),
  },
  {
    id: 'overdue_courses', label: 'Overdue training courses', module: 'hr', severity: 'low',
    notCaptured: 'Training modules have no due date in DharwinOne, so overdue training is not captured.',
  },
]);

function itemResult(item, section) {
  const base = { id: item.id, label: item.label, module: item.module, severity: item.severity, source: item.tool ?? null };
  if (section.status === 'restricted') return { ...base, status: 'restricted' };
  const { status, count = null, rows = [], ...extra } = section;
  return {
    ...base,
    status,
    count: status === 'ok' ? count : null,
    rows: status === 'ok' ? trimRows(rows, TOP_ROWS) : [],
    windowed: !!item.windowed,
    ...extra,
    ...(item.note ? { note: item.note } : {}),
    ...(item.nudge ? { nudge: item.nudge } : {}),
  };
}

const byUrgency = (a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  || ((b.status === 'ok' ? b.count ?? 0 : -1) - (a.status === 'ok' ? a.count ?? 0 : -1));

/**
 * The attention digest (also embedded in get_operations_summary, called directly — not through runTool —
 * so a composite that runs get_attention_digest via runTool still has one compose level left).
 * ponytail: one runTool per item (two with compareTo), all in parallel; each Wave 1 tool runs its own
 * few queries, so a full digest is ~30–60 small queries. Fine per chat turn; past that, cache per viewer.
 */
export async function runDigest({ scope = 'all', module = 'all', window, compareTo } = {}, ctx) {
  const now = (ctx?.deps?.now ?? (() => new Date()))();
  const today = istToday(now);
  const w = resolveWindow(window, now);
  const mine = scope === 'mine';
  const inModule = DIGEST_ITEMS.filter((i) => module === 'all' || i.module === module);
  const notScopedToYou = mine ? inModule.filter((i) => i.tool && !i.mine).map((i) => i.label) : [];
  const kept = inModule.filter((i) => !mine || !i.tool || i.mine);
  const callable = kept.filter((i) => i.tool);
  const before = compareTo === 'previous' ? previousWindow(w) : null;
  const compared = before ? callable.filter((i) => i.windowed) : [];

  const call = (i, win, limit) => ({ name: i.tool, args: i.args({ window: win, today, mine, limit }), timeoutMs: SECTION_TIMEOUT_MS });
  const outcomes = await runSections([
    ...callable.map((i) => call(i, w, TOP_ROWS)),
    ...compared.map((i) => call(i, before, 1)),
  ], ctx);

  const items = callable.map((i, idx) => itemResult(i, sectionFrom(outcomes[idx], i.pick ?? listPick)));
  compared.forEach((i, k) => {
    const item = items[callable.indexOf(i)];
    const prev = sectionFrom(outcomes[callable.length + k], i.pick ?? listPick);
    if (item.status !== 'ok') return;
    item.compare = prev.status === 'ok' && prev.count != null && item.count != null
      ? { now: item.count, before: prev.count, delta: item.count - prev.count }
      : { now: item.count, before: null, delta: null, beforeStatus: prev.status };
  });
  for (const i of kept.filter((x) => x.notCaptured)) {
    items.push({ id: i.id, label: i.label, module: i.module, severity: i.severity, source: null, status: 'notCaptured', count: null, rows: [], note: i.notCaptured });
  }
  items.sort(byUrgency);

  return {
    scope,
    module,
    window: w,
    items,
    restricted: items.filter((i) => i.status === 'restricted').map((i) => i.label),
    failed: items.filter((i) => i.status === 'error' || i.status === 'timeout').map((i) => ({ label: i.label, status: i.status })),
    ...(mine ? { notScopedToYou } : {}),
    ...(before ? {
      compareTo: 'previous',
      previousWindow: before,
      noWindow: callable.filter((i) => !i.windowed).map((i) => i.label),
    } : {}),
  };
}
