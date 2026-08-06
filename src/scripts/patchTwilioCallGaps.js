/**
 * Patch Twilio dialer call-record gaps for a date window.
 *
 * Why this exists instead of "Sync Dialer": backfillTwilioDialerCalls() skips
 * inbound legs (so it can never recover a missing parent leg) and upserts every
 * `outbound-dial` child leg as its own record — which would double every dialer
 * call in the list. This script does the opposite: parent legs only.
 *
 * Fixes two things:
 *   1. missing parent legs  — calls Twilio has that we have no CallRecord for
 *   2. stale status         — rows whose final webhook never landed
 *
 * Writes go through callRecordService.upsertDialerCallRecord, so the monotonic
 * statusRank guard still applies (a stale row can never move backwards).
 *
 * Usage:
 *   node src/scripts/patchTwilioCallGaps.js                 # dry run (default)
 *   node src/scripts/patchTwilioCallGaps.js --apply
 *   node src/scripts/patchTwilioCallGaps.js --verify        # re-diff, assert clean
 *   node src/scripts/patchTwilioCallGaps.js --undo
 *   node src/scripts/patchTwilioCallGaps.js --from 2026-07-30 --to 2026-08-06
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import CallRecord from '../models/callRecord.model.js';
import callRecordService from '../services/callRecord.service.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const APPLY = has('--apply');
const UNDO = has('--undo');
const VERIFY = has('--verify');
const FROM = new Date(`${arg('--from', '2026-07-30')}T00:00:00.000Z`);
const TO = new Date(`${arg('--to', '2026-08-06')}T00:00:00.000Z`);

const BACKUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.patchTwilioCallGaps.backup.json');
const ts = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');
const isReal = (n) => Boolean(n) && !String(n).startsWith('client:');
/** `client:user_<objectId>` -> the ObjectId, so the row lands in that agent's records. */
const userIdFrom = (identity) => {
  const m = /^client:user_([a-f0-9]{24})$/i.exec(String(identity || ''));
  return m ? m[1] : null;
};
/** Twilio's `-` form vs our `_` enum (no-answer -> no_answer). */
const norm = (s) => String(s || '').replace(/-/g, '_');

/**
 * Parent legs only. A dialer call is two Twilio legs: the parent (browser client
 * -> Twilio, direction `inbound`) and the child it dials out (`outbound-dial`).
 * Child legs carry no independent record — including them would duplicate.
 */
function parentLegs(calls) {
  return calls.filter((c) => !c.parentCallSid);
}

async function loadTwilio() {
  const { default: twilio } = await import('twilio');
  return twilio(process.env.TWILIO_AUTH_ID, process.env.TWILIO_AUTH_TOKEN).calls.list({
    startTimeAfter: FROM,
    startTimeBefore: TO,
    limit: 1000,
  });
}

/** Destination number: prefer the parent's `to`, else the child leg it dialed. */
function destinationOf(parent, allCalls) {
  if (isReal(parent.to)) return String(parent.to);
  const child = allCalls.find((c) => c.parentCallSid === parent.sid && isReal(c.to));
  return child ? String(child.to) : undefined;
}

/**
 * Stamp the real call time, bypassing Mongoose.
 *
 * upsertDialerCallRecord passes the true start time via $setOnInsert.createdAt,
 * but the schema's `timestamps: true` overwrites it with now() on upsert. That
 * is not cosmetic: twilioDialerGroupKey buckets by createdBy|to|from|2min, so
 * several client-leg rows (empty to/from) stamped in the same instant collide
 * and consolidateTwilioDialerDuplicates deletes all but one. Writing through
 * the native driver skips the timestamp middleware.
 */
async function forceCreatedAt(executionId, when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return;
  await CallRecord.collection.updateOne({ executionId: String(executionId) }, { $set: { createdAt: d } });
}

/**
 * Rows are seeded when we place the call, Twilio stamps when it starts — a few
 * minutes of lag is normal and not worth rewriting. Only gross errors (a row
 * stamped with the backfill time instead of the call time) exceed this.
 */
const DATE_TOLERANCE_MS = 5 * 60 * 1000;

async function diff() {
  const calls = await loadTwilio();
  const parents = parentLegs(calls);
  const rows = await CallRecord.find({ executionId: { $in: parents.map((p) => p.sid) } })
    .select('executionId status statusRank duration createdAt')
    .lean();
  const byId = new Map(rows.map((r) => [String(r.executionId), r]));

  const missing = parents.filter((p) => !byId.has(p.sid));
  const drift = parents
    .map((p) => ({ call: p, row: byId.get(p.sid) }))
    .filter(({ call, row }) => row && norm(row.status) !== norm(call.status));
  const dateDrift = parents
    .map((p) => ({ call: p, row: byId.get(p.sid) }))
    .filter(
      ({ call, row }) =>
        row && call.startTime && Math.abs(new Date(row.createdAt).getTime() - new Date(call.startTime).getTime()) > DATE_TOLERANCE_MS
    );

  return { calls, parents, missing, drift, dateDrift };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);

  if (UNDO) {
    if (!fs.existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP} — nothing to undo`);
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    for (const sid of backup.inserted) {
      await CallRecord.deleteOne({ executionId: sid });
      console.log(`  deleted ${sid}`);
    }
    for (const prev of backup.updated) {
      await CallRecord.updateOne(
        { executionId: prev.executionId },
        {
          $set: {
            status: prev.status,
            statusRank: prev.statusRank ?? 0,
            duration: prev.duration ?? null,
            statusUpdatedAt: prev.statusUpdatedAt ? new Date(prev.statusUpdatedAt) : null,
            completedAt: prev.completedAt ? new Date(prev.completedAt) : null,
          },
        }
      );
      console.log(`  reverted ${prev.executionId} -> ${prev.status}`);
    }
    for (const prev of backup.redated || []) {
      await CallRecord.collection.updateOne(
        { executionId: prev.executionId },
        { $set: { createdAt: new Date(prev.createdAt) } }
      );
      console.log(`  un-redated ${prev.executionId} -> ${ts(prev.createdAt)}`);
    }
    fs.unlinkSync(BACKUP);
    console.log(
      `\nundo complete: ${backup.inserted.length} deleted, ${backup.updated.length} reverted, ${(backup.redated || []).length} un-redated`
    );
    await mongoose.disconnect();
    return;
  }

  const { calls, parents, missing, drift, dateDrift } = await diff();
  console.log(`window ${ts(FROM)} .. ${ts(TO)} | twilio legs=${calls.length} parents=${parents.length}`);
  console.log(`missing from DB: ${missing.length} | status drift: ${drift.length} | date drift: ${dateDrift.length}\n`);

  if (VERIFY) {
    const ok = missing.length === 0 && drift.length === 0 && dateDrift.length === 0;
    for (const c of missing) console.log(`  STILL MISSING ${c.sid}`);
    for (const d of drift) console.log(`  STILL DRIFTED ${d.call.sid} db=${d.row.status} twilio=${d.call.status}`);
    for (const d of dateDrift) console.log(`  STILL DATE-DRIFTED ${d.call.sid} db=${ts(d.row.createdAt)} twilio=${ts(d.call.startTime)}`);
    console.log(ok ? '\nVERIFY PASS — window is clean' : '\nVERIFY FAIL');
    await mongoose.disconnect();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  for (const c of missing) {
    console.log(
      `INSERT ${ts(c.startTime)} ${c.sid} ${c.status} ${c.duration ?? 0}s to=${destinationOf(c, calls) || '-'} from=${c.from} createdBy=${userIdFrom(c.from) || 'null'}`
    );
  }
  for (const { call, row } of drift) {
    console.log(`UPDATE ${call.sid} status ${row.status} -> ${norm(call.status)} duration ${row.duration ?? '-'} -> ${call.duration ?? '-'}`);
  }
  for (const { call, row } of dateDrift) {
    console.log(`REDATE ${call.sid} createdAt ${ts(row.createdAt)} -> ${ts(call.startTime)}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — rerun with --apply to write');
    await mongoose.disconnect();
    return;
  }

  // Append to any existing backup — a second --apply must not throw away the
  // undo data from the first one.
  const backup = fs.existsSync(BACKUP)
    ? JSON.parse(fs.readFileSync(BACKUP, 'utf8'))
    : { window: [FROM, TO], inserted: [], updated: [], redated: [] };
  backup.inserted = backup.inserted || [];
  backup.updated = backup.updated || [];
  backup.redated = backup.redated || [];
  for (const { call } of drift) {
    if (backup.updated.some((u) => u.executionId === call.sid)) continue; // keep the oldest snapshot
    const full = await CallRecord.findOne({ executionId: call.sid })
      .select('executionId status statusRank duration statusUpdatedAt completedAt')
      .lean();
    backup.updated.push(full);
  }
  backup.redated.push(...dateDrift.map(({ call, row }) => ({ executionId: call.sid, createdAt: row.createdAt })));
  backup.inserted.push(...missing.map((c) => c.sid));
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
  console.log(`\nbackup written -> ${BACKUP}`);

  for (const c of [...missing, ...drift.map((d) => d.call)]) {
    const isNew = missing.some((m) => m.sid === c.sid);
    await callRecordService.upsertDialerCallRecord({
      executionId: c.sid,
      createdBy: isNew ? userIdFrom(c.from) : undefined,
      toPhoneNumber: destinationOf(c, calls),
      fromPhoneNumber: isReal(c.from) ? String(c.from) : undefined,
      status: c.status,
      duration: c.duration,
      direction: 'outbound',
      createdAt: c.startTime || undefined,
      source: isNew ? 'backfill' : undefined,
    });
    // Must follow the upsert — Mongoose stamped createdAt=now() and ignored ours.
    if (isNew && c.startTime) await forceCreatedAt(c.sid, c.startTime);
    console.log(`  ${isNew ? 'inserted' : 'updated '} ${c.sid}`);
  }
  for (const { call } of dateDrift) {
    await forceCreatedAt(call.sid, call.startTime);
    console.log(`  redated  ${call.sid} -> ${ts(call.startTime)}`);
  }

  const after = await diff();
  const clean = after.missing.length === 0 && after.drift.length === 0 && after.dateDrift.length === 0;
  console.log(
    `\npost-apply re-diff: missing=${after.missing.length} drift=${after.drift.length} dateDrift=${after.dateDrift.length}`
  );
  if (!clean) {
    for (const d of after.drift) console.log(`  drift remains ${d.call.sid} db=${d.row.status} twilio=${d.call.status}`);
    for (const d of after.dateDrift) console.log(`  date drift remains ${d.call.sid} db=${ts(d.row.createdAt)}`);
    console.log('(a remaining status drift means the statusRank guard refused a backwards move — expected, not an error)');
  }
  console.log(clean ? 'DONE — window clean' : 'DONE — see notes above');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
