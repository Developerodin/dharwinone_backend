/* Idempotent classification backfill: CallRecord.callSource.
 *
 * New rows are classified on write (model pre-save hook + upsertDialerCallRecord).
 * This tags rows written before that existed, using the SAME classifier, so the
 * two can never drift.
 *
 * Touches ONLY callSource. Timestamps, phones, duration, recording, transcript,
 * provider ids, candidate/job and createdBy are read-only here.
 *
 * Rows the classifier cannot place are left unset and reported — an unclassified
 * row shows under "All Calls" and under none of the three category tabs, which
 * is preferable to guessing.
 *
 *   npm run backfill:callrecord-source:dry   # preview
 *   npm run backfill:callrecord-source       # apply
 *   ... --reclassify                         # also re-tag already-classified rows
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { classifyCallSource } from '../utils/callSource.js';

const dryRun = process.argv.includes('--dry');
// Re-tag rows that already have a callSource (e.g. after the configured AI
// number changes). Off by default so a routine run is pure fill-in-the-blanks.
const reclassify = process.argv.includes('--reclassify');

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const coll = mongoose.connection.collection('callrecords');

  const filter = reclassify ? {} : { callSource: { $in: [null, ''] } };
  const rows = await coll
    .find(filter, {
      projection: {
        _id: 1,
        callSource: 1,
        'telephonyData.provider': 1,
        fromPhoneNumber: 1,
        userNumber: 1,
        agentId: 1,
        executionId: 1,
      },
    })
    .toArray();

  const counts = { ai_agent: 0, telephony: 0, in_app: 0 };
  let unchanged = 0;
  const unclassified = [];

  for (const row of rows) {
    const next = classifyCallSource(row);
    if (!next) {
      unclassified.push(String(row._id));
      continue;
    }
    if (row.callSource === next) {
      unchanged += 1;
      continue;
    }
    counts[next] += 1;
    if (!dryRun) {
      await coll.updateOne({ _id: row._id }, { $set: { callSource: next } });
    }
  }

  const prefix = dryRun ? '[DRY RUN] ' : '';
  console.log(
    `${prefix}examined: ${rows.length}; ai_agent: ${counts.ai_agent}; telephony: ${counts.telephony}; ` +
      `in_app: ${counts.in_app}; already correct: ${unchanged}; unclassified (left unset): ${unclassified.length}`
  );
  if (unclassified.length) {
    console.log(`  unclassified _ids (first 20): ${unclassified.slice(0, 20).join(', ')}`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
