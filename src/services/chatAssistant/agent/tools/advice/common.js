import { runTool as realRunTool, runTools as realRunTools } from '../../compose.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';

// Composite tools: every section runs a Wave 1 tool through compose.runTool under the viewer's own
// access, so the composite itself gates nothing (rule 5).
export const ADVICE_ACCESS = Object.freeze({ note: 'composite — each section runs its own tool under the viewer\'s access' });
export const NOT_CAPTURED = 'not captured in DharwinOne';
export const MAX_LIST_LIMIT = 50;
export const SECTION_ROWS = 5;

/** Fail closed without a user id, like every Wave 1 `<domain>Scope(ctx)`. */
export function adviceScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('advice tools need an authenticated user with an id');
  }
  return ctx.user;
}

/**
 * `run(name, args)` / `runAll([{ name, args }])` bound to the caller's ctx. `ctx.deps.runTool` swaps
 * compose.runTool in tests; production always goes through compose (access, Joi, timeout, row guard).
 */
export function adviceDeps(ctx) {
  const injected = ctx?.deps?.runTool;
  const run = (name, args, opts) => (injected ?? realRunTool)(name, args, ctx, opts);
  const runAll = injected
    ? (calls) => Promise.all(calls.map((c) => injected(c.name, c.args, ctx, { timeoutMs: c.timeoutMs })))
    : (calls) => realRunTools(calls, ctx);
  return { run, runAll, now: ctx?.deps?.now ?? (() => new Date()) };
}

/**
 * compose status → the section status a composite reports (rule 5). A tool-level refusal inside an
 * ok result (`forbidden`, an `error` string) is also reported as restricted / error, never as data.
 */
export function sectionStatus(out) {
  if (!out) return { status: 'error', error: 'no result' };
  if (out.status === 'ok') {
    const r = out.result;
    if (r?.forbidden) return { status: 'restricted', reason: r.error ?? null };
    if (r && typeof r.error === 'string') return { status: 'error', error: r.error };
    return { status: 'ok' };
  }
  if (out.status === 'restricted') return { status: 'restricted' };
  if (out.status === 'timeout') return { status: 'timeout' };
  if (out.status === 'unknown') return { status: 'error', error: 'tool not available' };
  return { status: 'error', error: out.error ?? 'failed' };
}

export const okResult = (out) => (sectionStatus(out).status === 'ok' ? out.result : null);

export const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** name → how many rows carry it, so a shared name is never silently joined to the wrong person. */
export function nameCounts(rows, key = 'name') {
  const counts = new Map();
  for (const r of rows || []) {
    const n = normName(r?.[key]);
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  return counts;
}

export const todayIst = (now) => dateStrInTz(now, DEFAULT_TIMEZONE);
export const istDayOffset = (now, days) => addDaysToDateStr(todayIst(now), days);
export { daysBetween } from '../jobs/jobStats.js';

export function rule(text, source, met, evidence = null) {
  return { rule: text, source, met, evidence };
}

export const clampLimit = (limit, fallback = 20) => Math.min(Math.max(Number(limit) || fallback, 1), MAX_LIST_LIMIT);
