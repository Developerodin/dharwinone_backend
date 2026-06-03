/* eslint-disable no-console */
/**
 * Migration: correct internal-meeting scheduledAt corrupted by the wall-clock-as-UTC bug.
 *
 * Bug (frontend InternalMeetingsClient.buildScheduledAtFromForm): the meeting's
 * scheduledAt was built as `${date}T${time}:00.000Z`, stamping the creator's LOCAL
 * wall-clock (e.g. 20:00 IST) as 20:00 UTC, while `timezone` was stored as the real
 * zone (e.g. Asia/Calcutta). Result: every stored instant is ahead of reality by the
 * zone's offset, so invitation emails rendered ~+5:30 (IST) too late.
 *
 * Fix: the correct instant is the one whose wall-clock IN `timezone` equals the
 * stored instant's UTC wall-clock. That is `stored - zoneOffset`. For IST: minus 5:30.
 *
 * SAFETY:
 *  - Only InternalMeeting docs (the interview `Meeting` flow stored correct instants).
 *  - Only docs created BEFORE the fix deployed: gated by `--before <ISO>` on the _id
 *    creation time. Meetings created after the fix are already correct — never touched.
 *  - Idempotent: sets `tzCorrectedAt`; re-runs skip already-corrected docs.
 *  - Reversible: previous scheduledAt is recorded in `migration_log`.
 *  - UTC-zone meetings are no-ops (offset 0).
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import InternalMeeting from '../../src/models/internalMeeting.model.js';

dotenv.config();

export const MIGRATION_VERSION = '2026-06-03-internal-meeting-tz-shift';
export const BATCH_SIZE = 500;

/** Zones that need no correction (wall-clock == UTC, so the append-Z was already right). */
export const UTC_EQUIVALENT = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', '']);

/**
 * Minutes a zone is ahead of UTC at a given instant (DST-aware via Intl).
 * Returns 0 for an invalid/unknown zone (treated as no-op).
 */
export function zoneOffsetMinutes(timeZone, atDate) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = dtf.formatToParts(atDate).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - atDate.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Pure transform: given a corrupted stored instant + its timezone, return the
 * corrected instant (whose wall-clock in `timezone` equals the stored UTC wall-clock).
 * Returns the same instant when no correction applies.
 */
export function correctScheduledAt(storedDate, timezone) {
  if (!(storedDate instanceof Date) || Number.isNaN(storedDate.getTime())) return storedDate;
  const tz = (timezone || '').trim();
  if (UTC_EQUIVALENT.has(tz)) return storedDate;
  const offset = zoneOffsetMinutes(tz, storedDate);
  if (offset === 0) return storedDate;
  return new Date(storedDate.getTime() - offset * 60000);
}

/** ObjectId boundary for "created strictly before this instant". */
function idBefore(beforeDate) {
  return mongoose.Types.ObjectId.createFromTime(Math.floor(beforeDate.getTime() / 1000));
}

export const runForward = async ({ dryRun = false, before } = {}) => {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new Error('runForward requires a valid `before` Date (the fix-deploy cutoff).');
  }
  const col = InternalMeeting.collection;
  const migrationLog = mongoose.connection.collection('migration_log');
  const summary = {
    version: MIGRATION_VERSION,
    before: before.toISOString(),
    scanned: 0,
    corrected: 0,
    wouldCorrect: 0,
    skippedNoOp: 0,
    dryRun,
    startedAt: new Date(),
  };

  const query = {
    _id: { $lt: idBefore(before) },
    tzCorrectedAt: { $exists: false },
    scheduledAt: { $type: 'date' },
    timezone: { $nin: [...UTC_EQUIVALENT, null] },
  };

  for await (const doc of col.find(query)) {
    summary.scanned++;
    const corrected = correctScheduledAt(doc.scheduledAt, doc.timezone);
    if (corrected.getTime() === doc.scheduledAt.getTime()) {
      summary.skippedNoOp++;
      continue;
    }
    if (dryRun) {
      summary.wouldCorrect++;
      continue;
    }
    const now = new Date();
    const result = await col.updateOne(
      { _id: doc._id, scheduledAt: doc.scheduledAt, tzCorrectedAt: { $exists: false } },
      { $set: { scheduledAt: corrected, tzCorrectedAt: now } }
    );
    if (result.modifiedCount === 1) {
      await migrationLog.insertOne({
        version: MIGRATION_VERSION,
        meetingId: doc._id,
        timezone: doc.timezone,
        previousScheduledAt: doc.scheduledAt,
        nextScheduledAt: corrected,
        offsetMinutes: zoneOffsetMinutes((doc.timezone || '').trim(), doc.scheduledAt),
        timestamp: now,
      });
      summary.corrected++;
    }
  }

  summary.finishedAt = new Date();
  return summary;
};

export const runReverse = async () => {
  const col = InternalMeeting.collection;
  const migrationLog = mongoose.connection.collection('migration_log');
  const summary = { version: MIGRATION_VERSION, restored: 0, skipped: 0, startedAt: new Date() };

  for await (const log of migrationLog.find({ version: MIGRATION_VERSION }).sort({ timestamp: -1 })) {
    // Only revert rows still holding the value this migration wrote (no later edit).
    const result = await col.updateOne(
      { _id: log.meetingId, scheduledAt: log.nextScheduledAt },
      { $set: { scheduledAt: log.previousScheduledAt }, $unset: { tzCorrectedAt: '' } }
    );
    if (result.modifiedCount === 1) summary.restored++;
    else summary.skipped++;
  }

  summary.finishedAt = new Date();
  return summary;
};

export const preFlight = async ({ before } = {}) => {
  const col = InternalMeeting.collection;
  const total = await col.countDocuments({});
  const nonUtc = await col.countDocuments({ timezone: { $nin: [...UTC_EQUIVALENT, null] } });
  const alreadyCorrected = await col.countDocuments({ tzCorrectedAt: { $exists: true } });
  const eligible = before instanceof Date && !Number.isNaN(before.getTime())
    ? await col.countDocuments({
        _id: { $lt: idBefore(before) },
        tzCorrectedAt: { $exists: false },
        scheduledAt: { $type: 'date' },
        timezone: { $nin: [...UTC_EQUIVALENT, null] },
      })
    : null;
  return {
    version: MIGRATION_VERSION,
    before: before instanceof Date ? before.toISOString() : null,
    totalInternalMeetings: total,
    nonUtcTimezone: nonUtc,
    alreadyCorrected,
    eligibleForCorrection: eligible,
  };
};

if (
  process.argv[1]
  && process.argv[1].endsWith('2026-06-03-internal-meeting-tz-shift.js')
) {
  const reverse = process.argv.includes('--reverse');
  const dryRun = process.argv.includes('--dry-run');
  const beforeArg = process.argv.find((a) => a.startsWith('--before='));
  const before = beforeArg ? new Date(beforeArg.slice('--before='.length)) : null;

  (async () => {
    if (!process.env.MONGODB_URL) {
      console.error('MONGODB_URL not set in env');
      process.exit(2);
    }
    await mongoose.connect(process.env.MONGODB_URL);
    try {
      console.log('[Migration] Pre-flight:', JSON.stringify(await preFlight({ before }), null, 2));
      if (reverse) {
        const s = await runReverse();
        console.log('[Migration] Reverse summary:', JSON.stringify(s, null, 2));
      } else {
        if (!before || Number.isNaN(before.getTime())) {
          console.error(
            '[Migration] Refusing to run forward without --before=<ISO>. '
            + 'Pass the fix-deploy timestamp so meetings created after the fix '
            + '(already correct) are not shifted. Example: '
            + '--before=2026-06-03T12:00:00Z'
          );
          process.exit(2);
        }
        const s = await runForward({ dryRun, before });
        console.log('[Migration]', dryRun ? 'Dry-run' : 'Live', 'summary:', JSON.stringify(s, null, 2));
      }
    } finally {
      await mongoose.disconnect();
    }
  })();
}
