/* Idempotent backfill: populate locationMeta on jobs when resolvable from location text.
 * Run: node src/scripts/backfillJobLocationMeta.js        (apply)
 *      node src/scripts/backfillJobLocationMeta.js --dry   (preview only) */
import mongoose from 'mongoose';
import config from '../config/config.js';
import Job from '../models/job.model.js';
import { resolveLocationMeta } from '../utils/jobLocation.util.js';

const dryRun = process.argv.includes('--dry');

const metaEquals = (a, b) => {
  const keys = ['city', 'state', 'country', 'countryCode'];
  return keys.every((k) => (a?.[k] || '') === (b?.[k] || ''));
};

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const cursor = Job.find({}).select('_id location locationMeta').cursor();
  let scanned = 0;
  let updated = 0;
  let cleared = 0;
  let unchanged = 0;

  for await (const job of cursor) {
    scanned += 1;
    const nextMeta = resolveLocationMeta(job.location);
    const currentMeta = job.locationMeta || null;

    if (nextMeta && !metaEquals(currentMeta, nextMeta)) {
      updated += 1;
      if (!dryRun) {
        await Job.updateOne({ _id: job._id }, { $set: { locationMeta: nextMeta } });
      }
    } else if (!nextMeta && currentMeta && Object.keys(currentMeta).length > 0) {
      cleared += 1;
      if (!dryRun) {
        await Job.updateOne({ _id: job._id }, { $unset: { locationMeta: 1 } });
      }
    } else {
      unchanged += 1;
    }
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Scanned: ${scanned}; updated: ${updated}; cleared: ${cleared}; unchanged: ${unchanged}`
  );
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
