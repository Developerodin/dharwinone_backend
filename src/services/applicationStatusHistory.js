/**
 * JobApplication status history — the ONLY module allowed to write `JobApplication.status`
 * (H.statusWriteGuard.test.js fails on any other write). Every write also sets
 * `statusChangedAt` and appends one `statusHistory` entry, in the same database update, and
 * only when the status really changes.
 *
 * Four write shapes, pick the one matching the call site:
 *   initialStatusFields  — spread into JobApplication.create() for the `created` entry
 *   recordStatusChange   — one application by id / filter (plain $set + $push, never a pipeline
 *                          update: pipeline updates skip Mongoose casting)
 *   recordStatusChangeMany — updateMany replacement; each row records its own `from`
 *   applyStatusChange    — a loaded document the caller is about to save()
 *
 * Readers (Sage funnel / "unchanged for N days") use stageEntryDates, lastStatusChangeAt and
 * unchangedSinceFilter, which fall back to derived dates / createdAt when there is no history.
 */
import JobApplication from '../models/jobApplication.model.js';
import logger from '../config/logger.js';

const MAX_ATTEMPTS = 3;
export const BACKFILL_SOURCE_PREFIX = 'backfill:';

const idOf = (v) => v?._id ?? v ?? null;

/** One statusHistory entry, in the schema's field order. */
export const statusEntry = ({ from = null, to, at = new Date(), by = null, source, approximate = false }) => ({
  from: from ?? null,
  to,
  at,
  by: idOf(by),
  source,
  approximate: Boolean(approximate),
});

/**
 * Fields for a new application: the status plus its `created` history entry.
 * @param {string} [status='Applied']
 * @param {{ by?: any, at?: Date }} [opts]
 */
export const initialStatusFields = (status = 'Applied', { by = null, at = new Date() } = {}) => ({
  status,
  statusChangedAt: at,
  statusHistory: [statusEntry({ from: null, to: status, at, by, source: 'created' })],
});

/**
 * Move one application to `to`. Reads the current status, then updates only if it is still that
 * value (compare-and-set), so `from` is exact even under concurrent writers. A lost race re-reads
 * and retries (the old unconditional write always won; this keeps that outcome).
 *
 * @param {{ applicationId?: any, filter?: object }} target
 * @param {string} to
 * @param {{ by?: any, source: string, session?: import('mongoose').ClientSession|null, at?: Date }} opts
 * @returns {Promise<{ changed: boolean, from: string|null }>}
 */
export const recordStatusChange = async (target, to, { by = null, source, session = null, at } = {}) => {
  const base = target?.filter ?? { _id: idOf(target?.applicationId) };
  const opts = session ? { session } : {};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await JobApplication.findOne(base, { _id: 1, status: 1 }, opts).lean();
    if (!current || current.status === to) return { changed: false, from: current?.status ?? null };
    const from = current.status ?? null;
    const when = at ?? new Date();
    // eslint-disable-next-line no-await-in-loop
    const res = await JobApplication.updateOne(
      { _id: current._id, status: from },
      {
        $set: { status: to, statusChangedAt: when },
        $push: { statusHistory: statusEntry({ from, to, at: when, by, source }) },
        // Bump __v so a JobApplication loaded earlier fails its save() version check instead of
        // writing a stale statusHistory over this transition (stale-save failure).
        $inc: { __v: 1 },
      },
      opts
    );
    if (res?.modifiedCount > 0) return { changed: true, from };
  }
  logger.warn('[applicationStatusHistory] status kept changing under %s → %s (%s); gave up', JSON.stringify(base), to, source);
  return { changed: false, from: null };
};

/**
 * updateMany replacement: move every application matching `filter` (and not already `to`) to
 * `to`, one compare-and-set per row so each entry has that row's own `from`. Rows that raced are
 * picked up again by the next pass.
 *
 * @param {object} filter
 * @param {string} to
 * @param {{ by?: any, source: string, session?: import('mongoose').ClientSession|null, at?: Date }} opts
 * @returns {Promise<{ modified: number }>}
 */
export const recordStatusChangeMany = async (filter, to, { by = null, source, session = null, at } = {}) => {
  const opts = session ? { session } : {};
  let modified = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await JobApplication.find({ $and: [filter, { status: { $ne: to } }] }, { _id: 1, status: 1 }, opts).lean();
    if (!rows.length) break;
    const when = at ?? new Date();
    const ops = rows.map((r) => {
      const from = r.status ?? null;
      return {
        updateOne: {
          filter: { _id: r._id, status: from },
          update: {
            $set: { status: to, statusChangedAt: when },
            $push: { statusHistory: statusEntry({ from, to, at: when, by, source }) },
            $inc: { __v: 1 },
          },
        },
      };
    });
    // eslint-disable-next-line no-await-in-loop
    const res = await JobApplication.bulkWrite(ops, { ordered: false, ...opts });
    const n = res?.modifiedCount ?? 0;
    modified += n;
    if (n === rows.length) break;
  }
  return { modified };
};

/**
 * Document variant: mutate a loaded application before the caller's own save(). No-op (returns
 * false) when the status is unchanged.
 * @param {import('mongoose').Document} doc
 * @param {string} to
 * @param {{ by?: any, source: string, at?: Date }} opts
 * @returns {boolean}
 */
export const applyStatusChange = (doc, to, { by = null, source, at = new Date() } = {}) => {
  const from = doc.status ?? null;
  if (from === to) return false;
  doc.status = to;
  doc.statusChangedAt = at;
  const entry = statusEntry({ from, to, at, by, source });
  if (Array.isArray(doc.statusHistory)) doc.statusHistory.push(entry);
  else doc.statusHistory = [entry];
  return true;
};

/**
 * A later save() of a JobApplication loaded before recordStatusChange must not write `status`
 * or `statusHistory`. That update bumps __v, but a save of the earlier copy still replaces the
 * array and erases an offer transition that landed in between (stale-save failure). Unmark the
 * paths so mongoose leaves the database copy alone.
 */
export const omitStaleStatusFields = (doc) => {
  if (!doc || typeof doc.unmarkModified !== 'function') return doc;
  doc.unmarkModified('status');
  doc.unmarkModified('statusChangedAt');
  doc.unmarkModified('statusHistory');
  return doc;
};

// ─── Readers ────────────────────────────────────────────────────────────────────────────────

/**
 * History that records at least one stage. A first entry with `from` is partial (no creation
 * row) but still usable for the stages it names. Empty / missing history is not.
 */
export const hasUsableStatusHistory = (app) =>
  Array.isArray(app?.statusHistory) && app.statusHistory.some((e) => e?.to && e.at);

/** @deprecated use hasUsableStatusHistory — full means the first entry has no `from`. */
export const hasFullStatusHistory = (app) =>
  hasUsableStatusHistory(app) && app.statusHistory[0]?.from == null;

/**
 * When an application first entered each stage.
 *   basis 'history' — keyed by status from statusHistory (first entry per status);
 *                     approximate = a date used came from an `approximate` entry.
 *   basis 'derived' — the caller's stage-entry dates from interview / offer / placement records.
 *   basis 'none'    — neither; only `Applied` (createdAt) is known.
 * @param {{ createdAt?: Date, statusHistory?: object[] }} app
 * @param {Record<string, Date|null|undefined>} [derived]
 * @returns {{ basis: 'history'|'derived'|'none', approximate: boolean, stages: Record<string, Date> }}
 */
export const stageEntryDates = (app, derived = {}) => {
  if (hasUsableStatusHistory(app)) {
    const stages = {};
    let approximate = false;
    for (const e of app.statusHistory) {
      if (!e?.to || !e.at || stages[e.to] != null) continue;
      stages[e.to] = e.at;
      if (e.approximate) approximate = true;
    }
    // No invented creation row. Dates used here came from history, so basis stays history.
    // A missing start (first entry has `from`) is approximate, not a reason to drop the row.
    const startMissing = app.statusHistory[0]?.from != null;
    if (startMissing) approximate = true;
    return {
      basis: 'history',
      approximate,
      ...(startMissing ? { note: 'Status history does not start at creation; earlier stages are not recorded.' } : {}),
      stages,
    };
  }
  const stages = {};
  for (const [stage, at] of Object.entries(derived || {})) if (at) stages[stage] = at;
  const basis = Object.keys(stages).length ? 'derived' : 'none';
  if (app?.createdAt && stages.Applied == null) stages.Applied = app.createdAt;
  return { basis, approximate: false, stages };
};

/** Per-answer basis counts for a list of stageEntryDates results. */
export const tallyBasis = (results) =>
  results.reduce(
    (acc, r) => {
      acc[r.basis] += 1;
      if (r.approximate) acc.approximate += 1;
      return acc;
    },
    { history: 0, derived: 0, none: 0, approximate: 0 }
  );

/** Time of the last status change: statusChangedAt when present, else createdAt (a notes edit moves updatedAt and is not a status change). */
export const lastStatusChangeAt = (app) =>
  app?.statusChangedAt
    ? { at: app.statusChangedAt, basis: 'statusChangedAt' }
    : { at: app?.createdAt ?? null, basis: 'createdAt' };

/** Mongo clause (for a page's own filter via $and): status unchanged since `cutoff`. statusChangedAt after the cutoff does not match. */
export const unchangedSinceFilter = (cutoff) => ({
  $or: [{ statusChangedAt: { $lte: cutoff } }, { statusChangedAt: null, createdAt: { $lte: cutoff } }],
});

// ─── Backfill (scripts/backfill-application-status-history.js) ────────────────────────────────

/** Applications the backfill may fill: no history at all. Live history is never touched. */
export const NEEDS_BACKFILL_FILTER = Object.freeze({
  $or: [{ statusHistory: null }, { statusHistory: { $size: 0 } }],
});

/**
 * Live-only history: the status changed after deploy but before the backfill ran, so the first
 * entry has a `from` (no `created` entry). The backfill prepends the rebuilt timeline before it.
 */
export const PARTIAL_HISTORY_FILTER = Object.freeze({ 'statusHistory.0.from': { $ne: null } });

/** --undo selection: history exists and every entry came from the backfill. */
export const BACKFILL_UNDO_FILTER = Object.freeze({
  'statusHistory.0': { $exists: true },
  statusHistory: { $not: { $elemMatch: { source: { $not: /^backfill:/ } } } },
});

/** Same rule as BACKFILL_UNDO_FILTER, for one history array. */
export const isBackfillOnlyHistory = (history) =>
  Array.isArray(history) &&
  history.length > 0 &&
  history.every((e) => String(e?.source || '').startsWith(BACKFILL_SOURCE_PREFIX));

const validDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Rebuild one application's history from records that already exist. Pure.
 *   Applied at createdAt · manual/system changes from ActivityLog `jobApplication.update`
 *   (exact from/to/at/by) · Interview at the earliest interview Meeting.createdAt · Offered /
 *   Hired / Rejected at Offer.createdAt / acceptedAt / rejectedAt.
 * Sorted by time, consecutive duplicates dropped. If that chain does not end at the current
 * status, a final `approximate` entry at updatedAt closes the gap.
 *
 * `before` (partial live history): only events earlier than the first live entry count, and
 * `application` is passed as { createdAt, status: first live `from`, updatedAt: first live `at` }.
 *
 * @param {{ application: object, activityLogs?: object[], meetings?: object[], offer?: object|null, before?: Date|null }} input
 * @returns {{ statusHistory: object[], statusChangedAt: Date|null, approximate: boolean }}
 */
export const buildBackfillHistory = ({ application, activityLogs = [], meetings = [], offer = null, before = null }) => {
  const events = [];
  const createdAt = validDate(application?.createdAt);
  if (createdAt) events.push({ to: 'Applied', at: createdAt, source: 'backfill:created', rank: 0 });

  for (const log of activityLogs) {
    const before = log?.metadata?.statusBefore ?? null;
    const after = log?.metadata?.statusAfter ?? null;
    const at = validDate(log?.occurredAt) || validDate(log?.createdAt);
    if (!after || before === after || !at) continue;
    events.push({ from: before, exactFrom: true, to: after, at, by: log.actor ?? null, source: 'backfill:activity_log', rank: 1 });
  }

  const firstInterview = meetings
    .map((m) => validDate(m?.createdAt))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  if (firstInterview) events.push({ to: 'Interview', at: firstInterview, source: 'backfill:meeting', rank: 1 });

  if (offer) {
    const offered = validDate(offer.createdAt);
    const accepted = validDate(offer.acceptedAt);
    const rejected = validDate(offer.rejectedAt);
    if (offered) events.push({ to: 'Offered', at: offered, source: 'backfill:offer', rank: 1 });
    if (accepted) events.push({ to: 'Hired', at: accepted, source: 'backfill:offer', rank: 1 });
    if (rejected) events.push({ to: 'Rejected', at: rejected, source: 'backfill:offer', rank: 1 });
  }

  const cutoff = validDate(before);
  if (cutoff) for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].at >= cutoff) events.splice(i, 1);
  events.sort((a, b) => a.at - b.at || a.rank - b.rank);

  const statusHistory = [];
  for (const e of events) {
    const prevTo = statusHistory.length ? statusHistory[statusHistory.length - 1].to : null;
    if (statusHistory.length && e.to === prevTo) continue;
    statusHistory.push(
      statusEntry({ from: e.exactFrom ? e.from : prevTo, to: e.to, at: e.at, by: e.by ?? null, source: e.source })
    );
  }

  let approximate = false;
  const current = application?.status ?? null;
  const last = statusHistory[statusHistory.length - 1];
  if (current && (!last || last.to !== current)) {
    const updatedAt = validDate(application?.updatedAt);
    const at = updatedAt && last && updatedAt < last.at ? last.at : updatedAt || last?.at || null;
    if (at) {
      statusHistory.push(
        statusEntry({ from: last?.to ?? null, to: current, at, source: 'backfill:updated_at', approximate: true })
      );
      approximate = true;
    }
  }

  return {
    statusHistory,
    statusChangedAt: statusHistory.length ? statusHistory[statusHistory.length - 1].at : null,
    approximate,
  };
};
