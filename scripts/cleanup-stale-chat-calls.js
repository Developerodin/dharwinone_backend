/**
 * Soft-fix stale in-app ChatCall rows that pollute the calling page.
 *
 * Why these accumulate:
 *   - status='initiated' rows from POST /chats/conversations/:id/call —
 *     expireStaleCalls only sweeps 'ringing'/'ongoing', so 'initiated' leaks.
 *   - status='ringing' rows older than 60s when expireStaleCalls was never
 *     wired into listCallsForUser per the comment in chatCall.service.js.
 *   - status='ongoing' rows with no endedAt when the end signal was lost.
 *
 * Action (soft-fix, NOT delete):
 *   - 'initiated' (>5 min old, nobody joined room) -> 'missed' + endedAt
 *   - 'ringing'   (>60s old)                       -> 'missed' + endedAt
 *   - 'ongoing'   (>6h old, no endedAt)            -> 'completed' + endedAt + duration
 *
 * Usage:
 *   node scripts/cleanup-stale-chat-calls.js              # dry run, prints counts + samples
 *   node scripts/cleanup-stale-chat-calls.js --apply      # actually update
 *   node scripts/cleanup-stale-chat-calls.js --apply --hard  # hard delete instead of soft-fix
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MONGO_URL = process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URL) {
  console.error('No MongoDB URL found in env. Set MONGODB_URL.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const HARD = process.argv.includes('--hard');

const RING_TIMEOUT_MS = 60 * 1000;
const INITIATED_TIMEOUT_MS = 5 * 60 * 1000;
const ONGOING_MAX_MS = 6 * 60 * 60 * 1000;

const chatCallSchema = new mongoose.Schema({}, { strict: false });
const ChatCall = mongoose.models.ChatCall || mongoose.model('ChatCall', chatCallSchema);

async function main() {
  await mongoose.connect(MONGO_URL);
  const mode = APPLY ? (HARD ? 'APPLY HARD-DELETE' : 'APPLY SOFT-FIX') : 'DRY RUN';
  console.log(`Connected. Mode: ${mode}`);

  const now = Date.now();
  const initiatedCutoff = new Date(now - INITIATED_TIMEOUT_MS);
  const ringCutoff = new Date(now - RING_TIMEOUT_MS);
  const ongoingCutoff = new Date(now - ONGOING_MAX_MS);

  const initiatedFilter = {
    status: 'initiated',
    createdAt: { $lte: initiatedCutoff },
    $or: [
      { roomJoinedUserIds: { $exists: false } },
      { roomJoinedUserIds: { $size: 0 } },
    ],
  };
  const ringingFilter = {
    status: 'ringing',
    createdAt: { $lte: ringCutoff },
  };
  const ongoingFilter = {
    status: 'ongoing',
    startedAt: { $lte: ongoingCutoff },
    $or: [{ endedAt: null }, { endedAt: { $exists: false } }],
  };

  const [initiatedCount, ringingCount, ongoingCount] = await Promise.all([
    ChatCall.countDocuments(initiatedFilter),
    ChatCall.countDocuments(ringingFilter),
    ChatCall.countDocuments(ongoingFilter),
  ]);

  console.log('\nMatched rows:');
  console.log(`  initiated > 5 min, no joins : ${initiatedCount}`);
  console.log(`  ringing   > 60s             : ${ringingCount}`);
  console.log(`  ongoing   > 6h, no endedAt  : ${ongoingCount}`);
  console.log(`  TOTAL                       : ${initiatedCount + ringingCount + ongoingCount}`);

  const sampleProj = '_id status conversation caller createdAt startedAt endedAt livekitRoom';
  const samples = {
    initiated: await ChatCall.find(initiatedFilter).select(sampleProj).limit(5).lean(),
    ringing: await ChatCall.find(ringingFilter).select(sampleProj).limit(5).lean(),
    ongoing: await ChatCall.find(ongoingFilter).select(sampleProj).limit(5).lean(),
  };

  for (const [bucket, rows] of Object.entries(samples)) {
    if (!rows.length) continue;
    console.log(`\nSample ${bucket}:`);
    for (const r of rows) {
      console.log(
        `  ${r._id} status=${r.status} created=${r.createdAt?.toISOString?.() || '-'} ` +
          `started=${r.startedAt?.toISOString?.() || '-'} room=${r.livekitRoom || '-'}`
      );
    }
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply (soft-fix) or --apply --hard (delete).');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (HARD) {
    const [r1, r2, r3] = await Promise.all([
      ChatCall.deleteMany(initiatedFilter),
      ChatCall.deleteMany(ringingFilter),
      ChatCall.deleteMany(ongoingFilter),
    ]);
    console.log('\nHard-deleted:');
    console.log(`  initiated: ${r1.deletedCount}`);
    console.log(`  ringing  : ${r2.deletedCount}`);
    console.log(`  ongoing  : ${r3.deletedCount}`);
  } else {
    const nowDate = new Date();
    const [r1, r2, r3] = await Promise.all([
      ChatCall.updateMany(initiatedFilter, {
        $set: { status: 'missed', endedAt: nowDate },
      }),
      ChatCall.updateMany(ringingFilter, {
        $set: { status: 'missed', endedAt: nowDate },
      }),
      ChatCall.updateMany(ongoingFilter, [
        {
          $set: {
            status: 'completed',
            endedAt: '$$NOW',
            duration: {
              $round: [{ $divide: [{ $subtract: ['$$NOW', '$startedAt'] }, 1000] }, 0],
            },
          },
        },
      ]),
    ]);
    console.log('\nSoft-fixed:');
    console.log(`  initiated -> missed   : ${r1.modifiedCount}`);
    console.log(`  ringing   -> missed   : ${r2.modifiedCount}`);
    console.log(`  ongoing   -> completed: ${r3.modifiedCount}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
