/**
 * Broad trace of who an email / name belongs to and what happened.
 * Covers: users + candidates + activityLog (all actions),
 * also surfaces TTL config so you can tell whether old audit rows expired.
 *
 * Usage:
 *   node scripts/trace-user.js "<email>" "<name>"
 *   node scripts/trace-user.js                         # uses DEFAULTS below
 *
 * Read-only.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DEFAULTS = [
  { email: 'yaswanthpampana3@gmail.com', name: 'Yaswanth Pampana' },
  { email: 'pasupuletiabitha@gmail.com', name: 'Abitha Pasupuleti' },
];

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error('Missing MONGODB_URL');
  process.exit(1);
}

const passSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.models.User || mongoose.model('User', passSchema);
const ActivityLog = mongoose.models.ActivityLog || mongoose.model('ActivityLog', passSchema);
// Candidate/Employee model is backed by 'candidates' collection per existing scripts.
const Candidate = mongoose.models.Candidate || mongoose.model('Candidate', passSchema, 'candidates');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function trace({ email, name }) {
  const e = (email || '').trim().toLowerCase();
  const n = (name || '').trim();
  console.log(`\n========================================`);
  console.log(`TRACE  email="${e}"  name="${n}"`);
  console.log(`========================================`);

  const userRow = e ? await User.findOne({ email: e }, { _id: 1, name: 1, email: 1, status: 1, createdAt: 1, roleIds: 1 }).lean() : null;
  console.log(`\n[users]`);
  console.log(userRow ? `  EXISTS  _id=${userRow._id} name=${userRow.name} status=${userRow.status}` : `  not found`);

  let candidateRows = [];
  if (e || n) {
    const q = { $or: [] };
    if (e) q.$or.push({ email: e }, { 'profile.email': e }, { 'contact.email': e });
    if (n) q.$or.push({ name: new RegExp(escapeRegex(n), 'i') }, { fullName: new RegExp(escapeRegex(n), 'i') });
    if (q.$or.length) {
      candidateRows = await Candidate.find(q, { _id: 1, name: 1, fullName: 1, email: 1, status: 1, createdAt: 1, updatedAt: 1 }).lean();
    }
  }
  console.log(`\n[candidates]`);
  if (candidateRows.length) {
    for (const c of candidateRows) {
      console.log(`  _id=${c._id}  name=${c.name || c.fullName || '—'}  email=${c.email || '—'}  status=${c.status || '—'}  createdAt=${c.createdAt?.toISOString?.() || c.createdAt}`);
    }
  } else {
    console.log('  not found');
  }

  const idsAsEntity = [
    userRow?._id && String(userRow._id),
    ...candidateRows.map((c) => String(c._id)),
  ].filter(Boolean);

  const matchOr = [];
  if (e) {
    matchOr.push({ 'metadata.email': e });
    matchOr.push({ 'metadata.targetEmail': e });
    matchOr.push({ 'metadata.recipientEmail': e });
    matchOr.push({ 'metadata.userEmail': e });
  }
  if (n) {
    const rx = new RegExp(escapeRegex(n), 'i');
    matchOr.push({ 'metadata.targetUserName': rx });
    matchOr.push({ 'metadata.deletedNameSnapshot': rx });
    matchOr.push({ 'metadata.deletedUsernameSnapshot': rx });
    matchOr.push({ 'metadata.name': rx });
    matchOr.push({ 'metadata.fullName': rx });
    matchOr.push({ 'metadata.candidateName': rx });
  }
  if (idsAsEntity.length) {
    matchOr.push({ entityId: { $in: idsAsEntity } });
  }

  const logs = matchOr.length
    ? await ActivityLog.find({ $or: matchOr })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    : [];

  console.log(`\n[activitylogs] ${logs.length} row(s)`);
  if (logs.length) {
    const actorIds = [...new Set(logs.map((r) => String(r.actor)).filter(Boolean))];
    const actors = actorIds.length
      ? await User.find(
          { _id: { $in: actorIds.map((id) => new mongoose.Types.ObjectId(id)) } },
          { _id: 1, name: 1, email: 1 }
        ).lean()
      : [];
    const actorMap = Object.fromEntries(actors.map((a) => [String(a._id), a]));

    for (const r of logs) {
      const a = actorMap[String(r.actor)];
      const when = r.createdAt?.toISOString?.() || r.createdAt;
      const actorLabel = a ? `${a.name} <${a.email}>` : `(actor _id=${r.actor}, not in users)`;
      const metaPreview = JSON.stringify(r.metadata || {}).slice(0, 160);
      console.log(`  ${when}  ${r.action}  ${r.entityType}:${r.entityId}`);
      console.log(`    actor: ${actorLabel}`);
      console.log(`    ip: ${r.ip || '—'}  ua: ${(r.userAgent || '—').slice(0, 80)}`);
      console.log(`    meta: ${metaPreview}`);
    }
  }

  console.log(`\n[hints]`);
  console.log('  - No user.delete row + activity-log trace = deleted via direct mongo/script OR audit row expired (TTL).');
  console.log('  - Look at ACTIVITY_LOG_TTL_SECONDS env on backend to see retention window.');
}

async function main() {
  let pairs = DEFAULTS;
  if (process.argv.slice(2).length === 1) {
    pairs = [{ email: process.argv[2], name: '' }];
  } else if (process.argv.slice(2).length >= 2) {
    pairs = [];
    for (let i = 2; i < process.argv.length; i += 2) {
      pairs.push({ email: process.argv[i], name: process.argv[i + 1] || '' });
    }
  }

  console.log(`Connecting to ${MONGO_URL.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(MONGO_URL);

  for (const p of pairs) {
    try {
      await trace(p);
    } catch (err) {
      console.error(`Error tracing ${p.email}: ${err.message}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
