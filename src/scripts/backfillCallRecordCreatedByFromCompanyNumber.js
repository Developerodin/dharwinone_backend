/* Idempotent repair: orphan outbound telephony CallRecords whose fromPhoneNumber
 * matches an assigned company work number → createdBy = assignedTo.
 *
 * PSTN child-leg webhooks carry phone numbers, not client:user_<id>. The write
 * path now resolves server-side in upsertDialerCallRecord; this repairs rows
 * written before that fix. Touches ONLY createdBy.
 *
 *   npm run backfill:callrecord-createdby-company:dry   # preview
 *   npm run backfill:callrecord-createdby-company       # apply
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { CALL_SOURCES, classifyCallSource } from '../utils/callSource.js';
import { resolveUserIdForAssignedCallerId } from '../services/companyPhoneNumber.service.js';

const dryRun = process.argv.includes('--dry');

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const coll = mongoose.connection.collection('callrecords');

  const rows = await coll
    .find(
      { createdBy: null, fromPhoneNumber: { $nin: [null, ''] } },
      {
        projection: {
          _id: 1,
          callSource: 1,
          fromPhoneNumber: 1,
          userNumber: 1,
          executionId: 1,
          'telephonyData.provider': 1,
          'telephonyData.direction': 1,
        },
      }
    )
    .toArray();

  let eligible = 0;
  let updated = 0;
  const skipped = { notOutboundTelephony: 0, noAssignment: 0 };

  for (const row of rows) {
    const direction = row.telephonyData?.direction;
    if (direction !== 'outbound') {
      skipped.notOutboundTelephony += 1;
      continue;
    }

    const callSource = row.callSource || classifyCallSource(row);
    if (callSource !== CALL_SOURCES.TELEPHONY) {
      skipped.notOutboundTelephony += 1;
      continue;
    }

    const ownerId = await resolveUserIdForAssignedCallerId(row.fromPhoneNumber || row.userNumber);
    if (!ownerId) {
      skipped.noAssignment += 1;
      continue;
    }

    eligible += 1;
    if (!dryRun) {
      await coll.updateOne(
        { _id: row._id, createdBy: null },
        { $set: { createdBy: new mongoose.Types.ObjectId(ownerId) } }
      );
      updated += 1;
    }
  }

  const prefix = dryRun ? '[DRY RUN] ' : '';
  console.log(
    `${prefix}orphan rows with fromPhoneNumber: ${rows.length}; eligible: ${eligible}; ` +
      `updated: ${dryRun ? 0 : updated}; skipped (not outbound telephony): ${skipped.notOutboundTelephony}; ` +
      `skipped (no company assignment): ${skipped.noAssignment}`
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
