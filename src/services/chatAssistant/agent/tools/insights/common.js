import { runTool, runTools } from '../../compose.js';
import { runWithTimeout, TOOL_TIMEOUT } from '../../runWithTimeout.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { dayWindowBounds } from '../employees/common.js';

// Composite tools: the tool's own access is a note; every section gates itself through runTool.
export const INSIGHTS_ACCESS = Object.freeze({
  note: 'composite — each section runs another tool under the viewer\'s own access (compose.runTool)',
});

// Whole composite must finish under defineTool's 15000 cap; a section gives up first so the rest still report.
export const COMPOSITE_TIMEOUT_MS = 15000;
export const SECTION_TIMEOUT_MS = 10000;
export const MAX_ROWS = 5;

export const NOT_CAPTURED = 'not captured in DharwinOne';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today in IST (context.js DEFAULT_TIMEZONE) as YYYY-MM-DD. */
export function istToday(now) {
  return dateStrInTz(now, DEFAULT_TIMEZONE);
}

/** Validated whole-IST-day window (dayWindowBounds throws on an impossible or reversed day); default = today. */
export function resolveWindow(window, now) {
  const today = istToday(now);
  const w = { from: window?.from ?? window?.to ?? today, to: window?.to ?? window?.from ?? today };
  dayWindowBounds(w);
  return w;
}

/** The window of equal length that ends the day before `w` starts. */
export function previousWindow(w) {
  const days = Math.round((Date.parse(w.to) - Date.parse(w.from)) / DAY_MS) + 1;
  return { from: addDaysToDateStr(w.from, -days), to: addDaysToDateStr(w.from, -1) };
}

/** ctx.deps.runTool (tests) or compose.runTool; independent sections run in parallel. */
export function runSections(calls, ctx) {
  const fake = ctx?.deps?.runTool;
  if (!fake) return runTools(calls, ctx);
  return Promise.all(calls.map(({ name, args, timeoutMs }) => fake(name, args, ctx, { timeoutMs })));
}

export function runSection(name, args, ctx, timeoutMs = SECTION_TIMEOUT_MS) {
  return (ctx?.deps?.runTool ?? runTool)(name, args, ctx, { timeoutMs });
}

// Wave 1 tools refuse some viewers inside execute and return that as a result ({ forbidden } or an
// error naming the missing permission) rather than failing the access rule. Those are "restricted",
// not failures. ponytail: matched on wording; a tool whose refusal says none of these reads as error.
const DENIAL_RE = /not allowed|permission|not permitted|requires one of|only see your own/i;

export function isDenial(result) {
  return !!result && (result.forbidden === true || (typeof result.error === 'string' && DENIAL_RE.test(result.error)));
}

/**
 * compose.runTool outcome → section status. `pick(result)` maps an ok result to `{ count, rows, ... }`
 * and may override `status` (e.g. notRecorded). A restricted section carries no data at all.
 */
export function sectionFrom(outcome, pick) {
  if (!outcome || outcome.status === 'restricted') return { status: 'restricted' };
  if (outcome.status === 'timeout') return { status: 'timeout' };
  if (outcome.status !== 'ok') {
    return { status: 'error', error: outcome.error || `tool ${outcome.status}` };
  }
  const r = outcome.result;
  if (isDenial(r)) return { status: 'restricted' };
  if (!r || r.error) return { status: 'error', error: r?.error ? String(r.error) : 'empty result' };
  return { status: 'ok', ...pick(r) };
}

/** A direct (non-tool) section with the same timeout / never-throws contract as runTool. */
export async function guardedSection(fn, timeoutMs = SECTION_TIMEOUT_MS) {
  try {
    return await runWithTimeout(fn, timeoutMs);
  } catch (err) {
    if (err?.code === TOOL_TIMEOUT) return { status: 'timeout' };
    return { status: 'error', error: err?.message || String(err) };
  }
}

// Key fields a sample row may keep; everything else (ids of related docs, nested arrays) is dropped.
const ROW_KEYS = [
  'name', 'person', 'candidate', 'applicant', 'employeeId', 'job', 'jobPosition', 'title', 'code',
  'status', 'result', 'scheduledAt', 'when', 'callbackAt', 'appliedAt', 'joiningDate', 'daysPending',
  'dueDate', 'from', 'to', 'leaveType', 'designation', 'punchIn', 'punchOut', 'preBoardingStatus',
  'projectManager', 'profileCompletion', 'expiresOn', 'document', 'offerCode', 'missing', 'course', 'expired',
  'matchedOn', 'people',
];
const MAX_ROW_KEYS = 6;

export function trimRows(rows, n = MAX_ROWS) {
  return (Array.isArray(rows) ? rows : []).slice(0, n).map((row) => {
    const out = {};
    for (const k of ROW_KEYS) {
      if (Object.keys(out).length >= MAX_ROW_KEYS) break;
      const v = row?.[k];
      if (v !== undefined && v !== null && (typeof v !== 'object' || v instanceof Date)) out[k] = v;
    }
    return out;
  });
}

export const statusLabel = (s) => (s.status === 'ok' ? String(s.count ?? '—') : s.status);
