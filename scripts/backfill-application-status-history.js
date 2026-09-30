#!/usr/bin/env node
/**
 * Rebuild JobApplication.statusHistory / statusChangedAt for applications that predate them.
 *
 * Usage:
 *   node scripts/backfill-application-status-history.js                 # dry run (default, read-only)
 *   node scripts/backfill-application-status-history.js --limit 200     # dry run over the first 200
 *   node scripts/backfill-application-status-history.js --apply         # write
 *   node scripts/backfill-application-status-history.js --undo          # count what undo would remove
 *   node scripts/backfill-application-status-history.js --undo --apply  # remove backfill-only history
 *
 * TARGET: whatever MONGODB_URL points at. Staging and local development share ONE database,
 * so a "local" --apply writes the data staging serves.
 * ⚠️ PRODUCTION DB — production has its own database. Running this against staging does NOT
 * cover production; run it again there with the production connection string, AFTER the
 * backend that writes live history is deployed (see "Order" below).
 *
 * READ-ONLY UNLESS --apply: autoIndex/autoCreate are forced off (connecting must not build the
 * new { statusChangedAt: 1 } index — that is a deploy step), and every driver write method is
 * replaced with one that throws before anything is sent.
 *
 * Per application with no history (NEEDS_BACKFILL_FILTER), buildBackfillHistory() rebuilds:
 *   Applied at createdAt · ActivityLog `jobApplication.update` statusBefore→statusAfter (exact,
 *   manual PATCH and interview-schedule transitions) · Interview at the earliest interview
 *   Meeting.createdAt · Offered / Hired / Rejected at Offer.createdAt / acceptedAt / rejectedAt.
 *   When that chain does not reach the current status, a final entry at updatedAt is marked
 *   `approximate: true`.
 *
 * ActivityLog retention: when ACTIVITY_LOG_TTL_SECONDS > 0, Mongo's TTL index has already deleted
 * activity rows older than that, so older manual changes cannot be recovered; those applications
 * lean on meeting / offer dates and the approximate final entry. The value in force is printed.
 *
 * --apply: bulkWrite batches of 500; `$set` only on { _id, history still missing/empty }, so a
 * re-run is a no-op and live history is never overwritten; `timestamps: false`, so updatedAt (the
 * "untouched" fallback and the smartNudge staleness signal) does not move.
 * --undo --apply: `$unset` both fields only where EVERY entry's source starts with `backfill:`.
 *
 * Order: deploy first, then --apply. An application whose status changed after the deploy but
 * before the backfill holds live entries only (PARTIAL_HISTORY_FILTER); the rebuilt timeline up to
 * its first live entry is prepended ($position 0), live entries and statusChangedAt untouched.
 * --undo --apply also $pulls backfill entries from those mixed histories.
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';
import JobApplication from '../src/models/jobApplication.model.js';
import ActivityLog from '../src/models/activityLog.model.js';
import Meeting from '../src/models/meeting.model.js';
import Offer from '../src/models/offer.model.js';
import { ActivityActions, EntityTypes } from '../src/config/activityLog.js';
import {
  buildBackfillHistory,
  NEEDS_BACKFILL_FILTER,
  PARTIAL_HISTORY_FILTER,
  BACKFILL_UNDO_FILTER,
} from '../src/services/applicationStatusHistory.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const UNDO = argv.includes('--undo');
const limitAt = argv.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(argv[limitAt + 1]) : 0;
const BATCH = 500;
const SAMPLE_SIZE = 5;

const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite', 'createIndex',
  'createIndexes', 'dropIndex', 'dropIndexes', 'drop', 'rename',
];

/** Make every driver write throw in-process, before any bytes go to the server. */
const blockWrites = () => {
  const { Collection, Db } = mongoose.mongo;
  for (const m of WRITE_METHODS) {
    Collection.prototype[m] = function blocked() {
      throw new Error(`read-only run: ${m} on ${this?.collectionName ?? '?'} blocked`);
    };
  }
  Db.prototype.createCollection = function blocked() {
    throw new Error('read-only run: createCollection blocked');
  };
  try {
    Collection.prototype.updateOne.call({ collectionName: 'self-check' });
  } catch {
    return;
  }
  throw new Error('write block did not install — refusing to connect');
};

const fmt = (d) => (d ? new Date(d).toISOString() : '—');

const loadSources = async (ids) => {
  const [logs, meetings, offers] = await Promise.all([
    ActivityLog.find({
      entityType: EntityTypes.JOB_APPLICATION,
      entityId: { $in: ids.map(String) },
      action: ActivityActions.JOB_APPLICATION_UPDATE,
      'metadata.statusAfter': { $exists: true },
    })
      .select('entityId actor metadata.statusBefore metadata.statusAfter occurredAt createdAt')
      .lean(),
    Meeting.find({ applicationId: { $in: ids } }).select('applicationId createdAt').lean(),
    Offer.find({ jobApplication: { $in: ids } }).select('jobApplication createdAt acceptedAt rejectedAt').lean(),
  ]);
  const group = (rows, key) => {
    const map = new Map();
    for (const r of rows) {
      const k = String(r[key]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  };
  const offerByApp = new Map();
  // One offer per application is enforced on create; if history left two, the latest drives status.
  for (const o of offers) {
    const k = String(o.jobApplication);
    const prev = offerByApp.get(k);
    if (!prev || new Date(o.createdAt) > new Date(prev.createdAt)) offerByApp.set(k, o);
  }
  return { logsByApp: group(logs, 'entityId'), meetingsByApp: group(meetings, 'applicationId'), offerByApp };
};

const runBackfill = async () => {
  const totals = {
    applications: await JobApplication.countDocuments({}),
    needBackfill: await JobApplication.countDocuments(NEEDS_BACKFILL_FILTER),
    partial: await JobApplication.countDocuments(PARTIAL_HISTORY_FILTER),
    prefixed: 0,
    scanned: 0,
    fullyRebuilt: 0,
    approximate: 0,
    nothingToBuild: 0,
    written: 0,
  };
  const eventsBySource = {};
  const approximateByStatus = {};
  const samples = { full: [], approx: [] };

  let lastId = null;
  while (!LIMIT || totals.scanned < LIMIT) {
    const size = LIMIT ? Math.min(BATCH, LIMIT - totals.scanned) : BATCH;
    // eslint-disable-next-line no-await-in-loop
    const eligible = { $or: [NEEDS_BACKFILL_FILTER, PARTIAL_HISTORY_FILTER] };
    const rows = await JobApplication.find(lastId ? { $and: [eligible, { _id: { $gt: lastId } }] } : eligible)
      .sort({ _id: 1 })
      .limit(size)
      .select('_id status createdAt updatedAt statusHistory')
      .lean();
    if (!rows.length) break;
    lastId = rows[rows.length - 1]._id;
    totals.scanned += rows.length;

    // eslint-disable-next-line no-await-in-loop
    const { logsByApp, meetingsByApp, offerByApp } = await loadSources(rows.map((r) => r._id));
    const ops = [];
    for (const app of rows) {
      const id = String(app._id);
      const live = app.statusHistory?.[0]?.from != null ? app.statusHistory[0] : null;
      if (live) {
        const prefix = buildBackfillHistory({
          application: { createdAt: app.createdAt, status: live.from, updatedAt: live.at },
          activityLogs: logsByApp.get(id) || [],
          meetings: meetingsByApp.get(id) || [],
          offer: offerByApp.get(id) || null,
          before: live.at,
        }).statusHistory;
        if (!prefix.length) {
          totals.nothingToBuild += 1;
          continue;
        }
        totals.prefixed += 1;
        for (const e of prefix) eventsBySource[e.source] = (eventsBySource[e.source] || 0) + 1;
        ops.push({
          updateOne: {
            // Same first entry as read: nobody prepended in between, so a re-run is a no-op.
            filter: { _id: app._id, 'statusHistory.0.from': live.from, 'statusHistory.0.at': live.at },
            update: { $push: { statusHistory: { $each: prefix, $position: 0 } } },
            timestamps: false,
          },
        });
        continue;
      }
      const built = buildBackfillHistory({
        application: app,
        activityLogs: logsByApp.get(id) || [],
        meetings: meetingsByApp.get(id) || [],
        offer: offerByApp.get(id) || null,
      });
      if (!built.statusHistory.length) {
        totals.nothingToBuild += 1;
        continue;
      }
      for (const e of built.statusHistory) eventsBySource[e.source] = (eventsBySource[e.source] || 0) + 1;
      if (built.approximate) {
        totals.approximate += 1;
        approximateByStatus[app.status] = (approximateByStatus[app.status] || 0) + 1;
        if (samples.approx.length < 2) samples.approx.push({ app, built });
      } else {
        totals.fullyRebuilt += 1;
        if (samples.full.length < SAMPLE_SIZE && built.statusHistory.length > 1) samples.full.push({ app, built });
      }
      ops.push({
        updateOne: {
          filter: { _id: app._id, ...NEEDS_BACKFILL_FILTER },
          update: { $set: { statusHistory: built.statusHistory, statusChangedAt: built.statusChangedAt } },
          timestamps: false,
        },
      });
    }
    if (APPLY && ops.length) {
      // eslint-disable-next-line no-await-in-loop
      const res = await JobApplication.bulkWrite(ops, { ordered: false });
      totals.written += res.modifiedCount ?? 0;
    }
  }

  console.log('\ntotals:');
  console.log(`  applications in collection: ${totals.applications}`);
  console.log(`  without history (eligible):  ${totals.needBackfill}`);
  console.log(`  live-only history (eligible for prefix): ${totals.partial}`);
  console.log(`  scanned this run:            ${totals.scanned}${LIMIT ? ` (--limit ${LIMIT})` : ''}`);
  console.log(`  fully rebuilt:               ${totals.fullyRebuilt}`);
  console.log(`  approximate (final entry at updatedAt): ${totals.approximate}`);
  console.log(`  prefixed (live history kept): ${totals.prefixed}`);
  console.log(`  nothing to build:            ${totals.nothingToBuild}`);
  console.log(`  approximate by current status: ${JSON.stringify(approximateByStatus)}`);
  console.log('\nevents by source:');
  for (const [src, n] of Object.entries(eventsBySource).sort()) console.log(`  ${src.padEnd(22)} ${n}`);

  const picked = [...samples.full.slice(0, SAMPLE_SIZE - samples.approx.length), ...samples.approx].slice(0, SAMPLE_SIZE);
  console.log(`\nsample histories (${picked.length}):`);
  for (const { app, built } of picked) {
    console.log(`  application ${app._id}  current=${app.status}  created=${fmt(app.createdAt)}  updated=${fmt(app.updatedAt)}`);
    for (const e of built.statusHistory) {
      console.log(
        `    ${fmt(e.at)}  ${String(e.from ?? '∅').padEnd(11)} → ${String(e.to).padEnd(11)} ${e.source}` +
          `${e.by ? ' (by user)' : ''}${e.approximate ? '  ~approximate' : ''}`
      );
    }
    console.log(`    statusChangedAt = ${fmt(built.statusChangedAt)}`);
  }

  console.log(
    `\n${APPLY ? `wrote: ${totals.written} application(s)` : `would write: ${totals.fullyRebuilt + totals.approximate + totals.prefixed} application(s)`}`
  );
  if (!APPLY) console.log('dry run — nothing was written. Re-run with --apply to write.');
};

const runUndo = async () => {
  const MIXED = { $and: [{ 'statusHistory.source': /^backfill:/ }, { $nor: [BACKFILL_UNDO_FILTER] }] };
  const n = await JobApplication.countDocuments(BACKFILL_UNDO_FILTER);
  const mixed = await JobApplication.countDocuments(MIXED);
  console.log(`applications whose history is entirely backfill-made: ${n}`);
  console.log(`applications with backfill entries before live ones: ${mixed}`);
  if (!APPLY) {
    console.log('undo also needs --apply, so it cannot run by accident — nothing was written');
    return;
  }
  const res = await JobApplication.updateMany(
    BACKFILL_UNDO_FILTER,
    { $unset: { statusHistory: '', statusChangedAt: '' } },
    { timestamps: false }
  );
  console.log(`undo: removed backfill history from ${res.modifiedCount} application(s)`);
  const pulled = await JobApplication.updateMany(
    MIXED,
    { $pull: { statusHistory: { source: /^backfill:/ } } },
    { timestamps: false }
  );
  console.log(`undo: removed backfill entries ahead of live history in ${pulled.modifiedCount} application(s)`);
};

const main = async () => {
  if (limitAt >= 0 && !(Number.isInteger(LIMIT) && LIMIT > 0)) throw new Error('--limit needs a positive integer');
  if (!APPLY) blockWrites();
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(config.mongoose.url, { ...config.mongoose.options, autoIndex: false, autoCreate: false });
  const conn = mongoose.connection;
  console.log(`database host: ${conn.host}  db: ${conn.name}`);
  console.log(
    `mode: ${UNDO ? (APPLY ? 'UNDO (writing)' : 'UNDO count (read-only)') : APPLY ? 'APPLY (writing)' : 'DRY RUN (read-only, writes blocked)'}`
  );
  console.log(`activity log TTL: ${config.activityLog.ttlSeconds || 0}s${config.activityLog.ttlSeconds ? ' — older manual changes may be gone' : ' (never expires)'}`);
  const oldestLog = await ActivityLog.findOne({ action: ActivityActions.JOB_APPLICATION_UPDATE })
    .sort({ createdAt: 1 })
    .select('createdAt')
    .lean();
  const oldestApp = await JobApplication.findOne({}).sort({ _id: 1 }).select('createdAt').lean();
  console.log(`oldest jobApplication.update log: ${fmt(oldestLog?.createdAt)} | oldest application: ${fmt(oldestApp?.createdAt)}`);

  if (UNDO) await runUndo();
  else await runBackfill();
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
