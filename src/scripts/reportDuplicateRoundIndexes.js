/**
 * READ-ONLY report: applications whose rounds share a round index.
 *
 * Reads. Writes nothing. Run it before creating the unique
 * (applicationId, round.index) index, because the index build FAILS while duplicates
 * exist — and that failure leaves the collection without the guarantee while looking
 * like an unrelated deploy error.
 *
 * Usage:  node src/scripts/reportDuplicateRoundIndexes.js
 *
 * Resolving a collision is a judgement call, not a migration: renumbering a round
 * changes what the candidate already saw in their own history. So this prints and stops.
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import Meeting from '../models/meeting.model.js';

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const duplicates = await Meeting.aggregate([
    { $match: { applicationId: { $ne: null }, 'round.index': { $ne: null } } },
    {
      $group: {
        _id: { applicationId: '$applicationId', index: '$round.index' },
        count: { $sum: 1 },
        meetings: {
          $push: { id: '$_id', meetingId: '$meetingId', status: '$status', scheduledAt: '$scheduledAt' },
        },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (!duplicates.length) {
    console.log('No duplicate round indexes. The unique index can be created safely.');
  } else {
    console.log(
      `${duplicates.length} collision group(s) found. The unique index will FAIL until these are resolved.\n`
    );
    for (const group of duplicates) {
      console.log(`application ${group._id.applicationId} — round ${group._id.index} — ${group.count} rounds`);
      for (const m of group.meetings) {
        const when = m.scheduledAt ? new Date(m.scheduledAt).toISOString() : 'no date';
        console.log(`    ${m.meetingId}  ${m.status}  ${when}  ${m.id}`);
      }
      console.log('');
    }
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
