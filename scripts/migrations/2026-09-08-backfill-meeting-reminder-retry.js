/**
 * Backfill reminderRetry / conclusionRetry on Meeting documents written before those
 * fields existed.
 *
 * Why it is needed: the reminder passes filter on `{'reminderRetry.attempts': {$lt: 3}}`,
 * and MongoDB does not match a document where that path is absent. Mongoose defaults are
 * applied on write, never retroactively, so those meetings can never be reminded. Same for
 * conclusionRetry and the "record the result" nudge.
 *
 * Idempotent: documents that already carry an `attempts` counter are skipped.
 *
 * Usage:
 *   node scripts/migrations/2026-09-08-backfill-meeting-reminder-retry.js          # dry-run
 *   node scripts/migrations/2026-09-08-backfill-meeting-reminder-retry.js --apply
 */
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();
const APPLY = process.argv.includes('--apply');

/**
 * The schema defaults, as a fresh object per call.
 * @returns {{attempts:number, claimedAt:null, lastError:null, lastErrorAt:null, lastErrorCategory:null, failedAt:null}}
 */
export function reminderRetryDefaults() {
  return {
    attempts: 0,
    claimedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorCategory: null,
    failedAt: null,
  };
}

/**
 * Pure: does this raw document lack either counter?
 * @param {Object} doc
 * @returns {boolean}
 */
export function needsBackfill(doc) {
  return (
    typeof doc?.reminderRetry?.attempts !== 'number' ||
    typeof doc?.conclusionRetry?.attempts !== 'number'
  );
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const meetings = mongoose.connection.db.collection('meetings');

  const filter = {
    $or: [
      { 'reminderRetry.attempts': { $exists: false } },
      { 'conclusionRetry.attempts': { $exists: false } },
    ],
  };
  const candidates = await meetings
    .find(filter)
    .project({ reminderRetry: 1, conclusionRetry: 1 })
    .toArray();
  const targets = candidates.filter(needsBackfill);

  console.log(`${targets.length} meeting(s) missing a retry counter`);

  if (!APPLY) {
    console.log('Dry run — pass --apply to write.');
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  for (const doc of targets) {
    const set = {};
    if (typeof doc?.reminderRetry?.attempts !== 'number') set.reminderRetry = reminderRetryDefaults();
    if (typeof doc?.conclusionRetry?.attempts !== 'number') set.conclusionRetry = reminderRetryDefaults();
    // eslint-disable-next-line no-await-in-loop
    const res = await meetings.updateOne({ _id: doc._id }, { $set: set });
    updated += res.modifiedCount;
  }

  console.log(`Backfilled ${updated} meeting(s)`);
  await mongoose.disconnect();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
