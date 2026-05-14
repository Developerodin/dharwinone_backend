/**
 * Surgical restore of `users` rows that were hard-deleted.
 *
 * Reads a JSON dump of the historical `users` collection (exported from an
 * Atlas snapshot via Restore -> Download -> bsondump -> mongoexport, OR
 * Restore-to-new-cluster -> mongoexport). For each historical row, checks
 * if the `_id` still exists in current prod; if missing, prepares to
 * re-insert.
 *
 * Dry-run by default — pass `--apply` to actually write.
 *
 * Usage:
 *   # 1. Dry-run, all dump rows
 *   node scripts/restore-missing-users.js path/to/users.json
 *
 *   # 2. Only restore specific emails (recommended for first pass)
 *   node scripts/restore-missing-users.js path/to/users.json --emails yaswanthpampana3@gmail.com,pasupuletiabitha@gmail.com
 *
 *   # 3. Apply (after reviewing dry-run output)
 *   node scripts/restore-missing-users.js path/to/users.json --emails ... --apply
 *
 * Safety rules:
 *   - Never overwrites a current row (skips on _id collision).
 *   - Never inserts when current `users` has a different row with the same
 *     email (flags for manual review).
 *   - Strips `password` field by default so users must reset their password
 *     after restore. Override with `--keep-password` if you really want.
 */
import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error('Missing MONGODB_URL');
  process.exit(1);
}

const args = process.argv.slice(2);
const dumpPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const keepPassword = args.includes('--keep-password');

let emailFilter = null;
const emailsIdx = args.indexOf('--emails');
if (emailsIdx !== -1) emailFilter = args[emailsIdx + 1];
const inlineEmails = args.find((a) => a.startsWith('--emails='));
if (inlineEmails) emailFilter = inlineEmails.split('=')[1];

const emailWhitelist = emailFilter
  ? new Set(emailFilter.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
  : null;

if (!dumpPath) {
  console.error('Pass path to users.json dump as first arg. See header comment for usage.');
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  console.error(`Dump file not found: ${dumpPath}`);
  process.exit(1);
}

// Mongo extended-JSON dumps wrap ObjectIds as { "$oid": "..." } and dates as
// { "$date": "..." }. Walk + unwrap so insert preserves real types.
function reviveExtJson(value) {
  if (Array.isArray(value)) return value.map(reviveExtJson);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$oid') {
      return new mongoose.Types.ObjectId(value.$oid);
    }
    if (keys.length === 1 && keys[0] === '$date') {
      return new Date(value.$date);
    }
    if (keys.length === 1 && keys[0] === '$numberLong') {
      return Number(value.$numberLong);
    }
    if (keys.length === 1 && keys[0] === '$numberDecimal') {
      return mongoose.Types.Decimal128.fromString(value.$numberDecimal);
    }
    const out = {};
    for (const k of keys) out[k] = reviveExtJson(value[k]);
    return out;
  }
  return value;
}

function parseDump(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (raw.startsWith('[')) {
    return JSON.parse(raw).map(reviveExtJson);
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => reviveExtJson(JSON.parse(line)));
}

const passSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.models.User || mongoose.model('User', passSchema);

async function main() {
  const dump = parseDump(dumpPath);
  console.log(`Loaded ${dump.length} rows from ${dumpPath}`);
  if (emailWhitelist) {
    console.log(`Filter: only rows with email in {${[...emailWhitelist].join(', ')}}`);
  }
  console.log(`Mode: ${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`Password handling: ${keepPassword ? 'KEEP (risky)' : 'STRIP (user must reset)'}`);
  console.log(`Connecting to ${MONGO_URL.replace(/\/\/[^@]+@/, '//<redacted>@')}`);

  await mongoose.connect(MONGO_URL);

  const candidates = dump.filter((u) => {
    if (!u || !u._id || !u.email) return false;
    if (emailWhitelist && !emailWhitelist.has(String(u.email).toLowerCase())) return false;
    return true;
  });
  console.log(`Candidates after filter: ${candidates.length}`);

  const ids = candidates.map((c) => c._id);
  const emails = candidates.map((c) => String(c.email).toLowerCase());
  const [existingById, existingByEmail] = await Promise.all([
    User.find({ _id: { $in: ids } }, { _id: 1, email: 1 }).lean(),
    User.find({ email: { $in: emails } }, { _id: 1, email: 1 }).lean(),
  ]);
  const existingIdSet = new Set(existingById.map((u) => String(u._id)));
  const existingEmailMap = new Map(existingByEmail.map((u) => [String(u.email).toLowerCase(), String(u._id)]));

  const plan = { willInsert: [], skipIdExists: [], skipEmailCollision: [], errors: [] };

  for (const row of candidates) {
    const id = String(row._id);
    const email = String(row.email).toLowerCase();

    if (existingIdSet.has(id)) {
      plan.skipIdExists.push({ id, email, name: row.name });
      continue;
    }
    const collidingId = existingEmailMap.get(email);
    if (collidingId && collidingId !== id) {
      plan.skipEmailCollision.push({ id, email, name: row.name, collidingId });
      continue;
    }
    plan.willInsert.push(row);
  }

  console.log(`\n=== plan ===`);
  console.log(`will-insert:        ${plan.willInsert.length}`);
  for (const u of plan.willInsert) {
    console.log(`  _id=${u._id} email=${u.email} name=${u.name || '—'} status=${u.status || '—'}`);
  }
  console.log(`skip (id-exists):   ${plan.skipIdExists.length}`);
  for (const u of plan.skipIdExists) {
    console.log(`  _id=${u.id} email=${u.email} name=${u.name || '—'}`);
  }
  console.log(`skip (email-coll.): ${plan.skipEmailCollision.length}`);
  for (const u of plan.skipEmailCollision) {
    console.log(`  _id=${u.id} email=${u.email} collidesWith=${u.collidingId}`);
  }

  if (!apply) {
    console.log(`\nDRY-RUN. Add --apply to actually insert ${plan.willInsert.length} row(s).`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nInserting ${plan.willInsert.length} row(s)...`);
  let inserted = 0;
  for (const row of plan.willInsert) {
    const doc = { ...row };
    if (!keepPassword) delete doc.password;
    if (!doc.status || doc.status === 'deleted') doc.status = 'pending';
    try {
      await User.create(doc);
      inserted += 1;
      console.log(`  OK _id=${doc._id} email=${doc.email}`);
    } catch (err) {
      console.error(`  FAIL _id=${doc._id} email=${doc.email}: ${err.message}`);
      plan.errors.push({ id: doc._id, email: doc.email, error: err.message });
    }
  }

  console.log(`\nApplied: inserted=${inserted} failed=${plan.errors.length}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
