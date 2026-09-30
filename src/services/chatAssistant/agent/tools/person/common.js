import { runTool as realRunTool, runTools as realRunTools } from '../../compose.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';

export const NOT_CAPTURED = 'not captured in DharwinOne';
// Per section: counts plus at most this many rows of key fields, so the whole 360 stays under ~20 KB.
export const MAX_ROWS = 5;

/** Fail closed: every section tool needs the viewer's id to scope its rows. */
export function personScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('person tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** compose.js runTool / runTools bound to this ctx; `ctx.deps.runTool` replaces both in tests. */
export function composeDeps(ctx) {
  const deps = ctx?.deps || {};
  const fake = deps.runTool;
  return {
    runTool: fake
      ? (name, args, opts) => fake(name, args, ctx, opts)
      : (name, args, opts) => realRunTool(name, args, ctx, opts),
    runTools: fake
      ? (calls) => Promise.all(calls.map(({ name, args, timeoutMs }) => fake(name, args, ctx, { timeoutMs })))
      : (calls) => realRunTools(calls, ctx),
    now: deps.now ?? (() => new Date()),
  };
}

/** Today's calendar day in the timezone the model resolves "today" in (IST). */
export function istToday(now = new Date()) {
  return dateStrInTz(now, DEFAULT_TIMEZONE);
}

/** The last `days` whole IST days, today included, as a { from, to } day window. */
export function lastIstDays(days, now = new Date()) {
  const to = istToday(now);
  return { from: addDaysToDateStr(to, 1 - days), to };
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Same person name, ignoring case and spacing — name searches elsewhere are substring matches. */
export function sameName(a, b) {
  return !!a && !!b && norm(a) === norm(b);
}

export const restricted = (note) => ({ status: 'restricted', ...(note ? { note } : {}) });
export const notRecorded = (note) => ({ status: 'notRecorded', ...(note ? { note } : {}) });
export const notCaptured = (note) => ({ status: 'notCaptured', note });
export const okSection = (summary, rows = []) => ({ status: 'ok', summary, rows: rows.slice(0, MAX_ROWS) });

/** Several records matched inside a section; the model asks which one and calls the section's own tool. */
export const ambiguousSection = (matches, tool) => okSection(
  { ambiguous: true, matches: matches.length, note: `Several records match — ask which one, then use ${tool}.` },
  matches,
);

/**
 * A runTool outcome that did not answer → its section, or null when the tool answered (read `.result`).
 * In-band `forbidden` is restricted; in-band `error` is restricted too unless the section says otherwise,
 * because every section tool uses it only for "you may not see this" (other people's rows, a page gate).
 */
export function failedSection(outcome, { errorIsRestricted = true } = {}) {
  if (!outcome) return { status: 'error', error: 'not run' };
  if (outcome.status === 'restricted') return restricted();
  if (outcome.status === 'timeout') return { status: 'timeout' };
  if (outcome.status !== 'ok') return { status: 'error', error: outcome.error || `tool ${outcome.status}` };
  const r = outcome.result;
  if (r?.forbidden) return restricted();
  if (r?.error) return errorIsRestricted ? restricted() : { status: 'error', error: String(r.error) };
  return null;
}

/** Only the named keys, nulls kept (null = not captured). */
export function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]));
}
