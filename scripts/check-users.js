/**
 * Check whether specific users exist (now or ever) in the Dharwin DB.
 *
 * Usage:
 *   node scripts/check-users.js email1@x.com email2@y.com ...
 *   node scripts/check-users.js                              # uses DEFAULT_EMAILS below
 *
 * Reports for each email:
 *   - current User row (if any): _id, name, status, createdAt
 *   - traces in ActivityLog where this email appears as actor (by joining User._id)
 *     or in any metadata field (string match — Mixed schema, no field guarantee)
 *
 * No writes. Safe to run against prod.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DEFAULT_EMAILS = [
  'yaswanthpampana3@gmail.com',
  'pasupuletiabitha@gmail.com',
];

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error('Missing MONGODB_URL in .env');
  process.exit(1);
}

const userSchema = new mongoose.Schema({}, { strict: false });
const activityLogSchema = new mongoose.Schema({}, { strict: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const ActivityLog = mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

async function checkOne(email) {
  console.log(`\n=== ${email} ===`);

  const user = await User.findOne(
    { email },
    {
      _id: 1, name: 1, email: 1, status: 1, roleIds: 1, registrationSource: 1,
      isEmailVerified: 1, createdAt: 1, updatedAt: 1, previousNames: 1, aliases: 1,
    }
  ).lean();

  if (user) {
    console.log('CURRENT USER:');
    console.log(`  _id:           ${user._id}`);
    console.log(`  name:          ${user.name || '—'}`);
    console.log(`  status:        ${user.status || '—'}`);
    console.log(`  isVerified:    ${user.isEmailVerified ? 'yes' : 'no'}`);
    console.log(`  source:        ${user.registrationSource || '—'}`);
    console.log(`  roleIds:       ${(user.roleIds || []).map(String).join(', ') || '—'}`);
    console.log(`  previousNames: ${(user.previousNames || []).join(', ') || '—'}`);
    console.log(`  aliases:       ${(user.aliases || []).join(', ') || '—'}`);
    console.log(`  createdAt:     ${user.createdAt?.toISOString?.() || user.createdAt || '—'}`);
    console.log(`  updatedAt:     ${user.updatedAt?.toISOString?.() || user.updatedAt || '—'}`);
  } else {
    console.log('CURRENT USER: NOT FOUND in users collection.');
  }

  // Activity-log trace.
  // 1. As actor (matched only if user row still exists — actor stores ObjectId).
  const actorTrace = user
    ? await ActivityLog.find({ actor: user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .select({ action: 1, entityType: 1, entityId: 1, createdAt: 1 })
        .lean()
    : [];

  if (actorTrace.length) {
    console.log(`ACTIVITY (as actor, last ${actorTrace.length}):`);
    for (const a of actorTrace) {
      console.log(`  ${a.createdAt?.toISOString?.() || a.createdAt}  ${a.action}  ${a.entityType}:${a.entityId}`);
    }
  } else if (user) {
    console.log('ACTIVITY (as actor): none.');
  }

  // 2. Email as substring inside any metadata field (Mixed schema = grep-style).
  // Mongo can't text-search Mixed, so cast to string then regex. Capped window
  // keeps it cheap; raise WINDOW if you want a longer history.
  const WINDOW = 200000;
  const metaTrace = await ActivityLog.aggregate([
    { $sort: { createdAt: -1 } },
    { $limit: WINDOW },
    {
      $project: {
        action: 1, entityType: 1, entityId: 1, createdAt: 1,
        // metadata is Mixed; cast safely. Objects can't $toString directly —
        // wrap in $convert with onError to fall back to a JSON-ish repr.
        metaStr: {
          $convert: {
            input: { $ifNull: ['$metadata', ''] },
            to: 'string',
            onError: { $reduce: {
              input: { $objectToArray: { $ifNull: ['$metadata', {}] } },
              initialValue: '',
              in: { $concat: ['$$value', ' ', '$$this.k', '=', { $convert: { input: '$$this.v', to: 'string', onError: '', onNull: '' } }] },
            } },
            onNull: '',
          },
        },
      },
    },
    { $match: { metaStr: { $regex: email, $options: 'i' } } },
    { $limit: 5 },
  ]);

  if (metaTrace.length) {
    console.log(`ACTIVITY (email in metadata, last ${metaTrace.length}):`);
    for (const a of metaTrace) {
      console.log(`  ${a.createdAt?.toISOString?.() || a.createdAt}  ${a.action}  ${a.entityType}:${a.entityId}`);
    }
  } else {
    console.log(`ACTIVITY (email in metadata): none in last ${WINDOW} log rows.`);
  }

  if (user) {
    console.log(`VERDICT: EXISTS — status=${user.status}`);
  } else if (actorTrace.length || metaTrace.length) {
    console.log('VERDICT: HARD-DELETED — no User row, but found activity-log trace.');
  } else {
    console.log('VERDICT: NEVER EXISTED — no User row, no activity-log trace within scanned window.');
  }
}

async function main() {
  const emails = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_EMAILS)
    .map(normalize)
    .filter(Boolean);

  if (!emails.length) {
    console.error('No emails to check.');
    process.exit(1);
  }

  console.log(`Connecting to ${MONGO_URL.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(MONGO_URL);

  for (const email of emails) {
    try {
      await checkOne(email);
    } catch (err) {
      console.error(`Error checking ${email}: ${err.message}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
