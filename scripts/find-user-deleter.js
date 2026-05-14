/**
 * Find who deleted a user — searches user.delete activity logs by NAME
 * (email is intentionally not stored in delete-audit metadata; sanitizer
 * strips email-shaped keys).
 *
 * Usage:
 *   node scripts/find-user-deleter.js "Abitha Pasupuleti" "Yaswanth Pampana"
 *   node scripts/find-user-deleter.js                                         # uses DEFAULTS below
 *
 * For each name pattern, prints every user.delete row whose
 *   metadata.targetUserName / metadata.deletedNameSnapshot / metadata.deletedUsernameSnapshot
 * matches (case-insensitive substring). Resolves actor → current user to
 * surface who pressed Delete, plus IP/UA/timestamp.
 *
 * Read-only.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DEFAULTS = [
  'Abitha Pasupuleti',
  'Yaswanth Pampana',
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findFor(name) {
  console.log(`\n=== "${name}" ===`);
  const rx = new RegExp(escapeRegex(name), 'i');

  const rows = await ActivityLog.find({
    action: 'user.delete',
    $or: [
      { 'metadata.targetUserName': rx },
      { 'metadata.deletedNameSnapshot': rx },
      { 'metadata.deletedUsernameSnapshot': rx },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!rows.length) {
    console.log('No user.delete audit rows match this name.');
    return;
  }

  const actorIds = [...new Set(rows.map((r) => String(r.actor)).filter(Boolean))];
  const actors = await User.find(
    { _id: { $in: actorIds.map((id) => new mongoose.Types.ObjectId(id)) } },
    { _id: 1, name: 1, email: 1, status: 1 }
  ).lean();
  const actorMap = Object.fromEntries(actors.map((a) => [String(a._id), a]));

  console.log(`Found ${rows.length} delete event(s):`);
  for (const r of rows) {
    const a = actorMap[String(r.actor)] || null;
    const when = r.createdAt?.toISOString?.() || r.createdAt;
    console.log('  ----------------------------------------');
    console.log(`  deletedAt:        ${when}`);
    console.log(`  deletedUserId:    ${r.entityId}`);
    console.log(`  targetUserName:   ${r.metadata?.targetUserName || '—'}`);
    console.log(`  nameSnapshot:     ${r.metadata?.deletedNameSnapshot || '—'}`);
    console.log(`  usernameSnapshot: ${r.metadata?.deletedUsernameSnapshot || '—'}`);
    console.log(`  hardDeleted:      ${r.metadata?.hardDeleted ? 'yes' : 'no'}`);
    console.log(`  actor _id:        ${r.actor}`);
    console.log(`  actor name:       ${a?.name || '(actor not in users collection — also deleted?)'}`);
    console.log(`  actor email:      ${a?.email || '—'}`);
    console.log(`  actor status:     ${a?.status || '—'}`);
    console.log(`  ip / clientIp:    ${r.ip || '—'} / ${r.clientIp || '—'}`);
    console.log(`  userAgent:        ${r.userAgent || '—'}`);
    console.log(`  httpMethod path:  ${r.httpMethod || '—'} ${r.httpPath || ''}`);
    if (r.geo || r.clientGeo) {
      const g = r.geo || {};
      const cg = r.clientGeo || {};
      const fmt = (x) => [x.city, x.region, x.country].filter(Boolean).join(', ') || '—';
      console.log(`  geo (server):     ${fmt(g)}`);
      console.log(`  geo (client):     ${fmt(cg)}`);
    }
  }
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
  console.log(`Connecting to ${MONGO_URL.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(MONGO_URL);
  for (const n of names) {
    try {
      await findFor(n);
    } catch (err) {
      console.error(`Error checking "${n}": ${err.message}`);
    }
  }
  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
