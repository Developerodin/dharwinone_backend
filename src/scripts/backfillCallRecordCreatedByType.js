/* Idempotent repair: CallRecord.createdBy stored as a BSON string -> ObjectId.
 *
 * upsertDialerCallRecord writes through an aggregation-pipeline $set, which
 * Mongoose does not cast. `req.user.id` (a string) therefore landed as a BSON
 * string, while every list query casts createdBy to ObjectId — so those rows
 * matched nothing and disappeared from the dialer's Recent list (they stayed
 * visible in Call Records only for Administrators, who get no createdBy filter).
 *
 * The write path is fixed; this repairs rows written before that fix.
 * Touches ONLY callrecords.createdBy. Nothing else is read or written.
 *
 *   npm run backfill:callrecord-createdby:dry   # preview
 *   npm run backfill:callrecord-createdby       # apply
 */
import mongoose from 'mongoose';
import config from '../config/config.js';

const dryRun = process.argv.includes('--dry');
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const coll = mongoose.connection.collection('callrecords');

  const rows = await coll
    .find({ createdBy: { $type: 'string' } }, { projection: { _id: 1, createdBy: 1 } })
    .toArray();

  let fixed = 0;
  const skipped = [];
  for (const row of rows) {
    if (!OBJECT_ID_RE.test(row.createdBy)) {
      // Not a user id at all — leave it for a human rather than guessing.
      skipped.push(`${row._id}: ${row.createdBy}`);
      continue;
    }
    fixed += 1;
    if (!dryRun) {
      await coll.updateOne(
        { _id: row._id },
        { $set: { createdBy: new mongoose.Types.ObjectId(row.createdBy) } }
      );
    }
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}string createdBy rows: ${rows.length}; converted: ${fixed}; skipped (not an ObjectId): ${skipped.length}`
  );
  for (const s of skipped) console.log(`  skipped ${s}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
