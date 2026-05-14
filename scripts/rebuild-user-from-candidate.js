/**
 * Rebuild a hard-deleted User row from the surviving Candidate row +
 * activity-log breadcrumbs. Use when Atlas backups are unavailable and the
 * goal is to restore login access without affecting anyone else's data.
 *
 * Strategy:
 *   1. Look up Candidate by email -> get name + recoverable fields.
 *   2. Probe activity logs for the original userId so refs stay valid
 *      (entityType=User where metadata.targetUserName matches the
 *      candidate name).
 *   3. Pick the "Candidate" Role doc (or whichever Role name you pass
 *      via --role) so the rebuilt user has working permissions.
 *   4. Insert a User doc with:
 *        - _id            = original (when found in logs)
 *        - email/name     = from candidate
 *        - status         = pending
 *        - isEmailVerified = true (they had verified before deletion)
 *        - password       = random 16-char + "Aa1" -> pre-save bcrypt hashes
 *          -> user MUST reset via forgot-password flow
 *
 * Dry-run by default. Add --apply to write.
 *
 * Usage:
 *   node scripts/rebuild-user-from-candidate.js --emails a@x.com,b@y.com
 *   node scripts/rebuild-user-from-candidate.js --emails a@x.com --role Candidate --apply
 *
 * SAFETY:
 *   - Skips if a User row with same email or same _id already exists.
 *   - Refuses to run if MONGODB_URL is missing.
 */
import crypto from 'crypto';
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
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
const apply = args.includes('--apply');
const emails = (flag('emails') || 'yaswanthpampana3@gmail.com,pasupuletiabitha@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const roleName = flag('role') || 'Candidate';

async function loadUserModel() {
  const { default: UserModel } = await import('../src/models/user.model.js');
  return UserModel;
}

const passSchema = new mongoose.Schema({}, { strict: false });
const ActivityLog = mongoose.models.ActivityLog || mongoose.model('ActivityLog', passSchema);
const Candidate = mongoose.models.Candidate || mongoose.model('Candidate', passSchema, 'candidates');
const Role = mongoose.models.Role || mongoose.model('Role', passSchema);

function genPassword() {
  return crypto.randomBytes(8).toString('hex') + 'Aa1';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findOriginalUserId(name) {
  const rx = new RegExp(escapeRegex(name), 'i');
  const row = await ActivityLog.findOne({
    entityType: 'User',
    $or: [
      { 'metadata.targetUserName': rx },
      { 'metadata.deletedNameSnapshot': rx },
    ],
  })
    .sort({ createdAt: 1 })
    .lean();
  return row?.entityId || null;
}

async function planOne(User, email) {
  console.log(`\n=== ${email} ===`);

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    console.log(`  SKIP: User row already exists. _id=${existing._id}`);
    return null;
  }

  const candidate = await Candidate.findOne({ email }).lean();
  if (!candidate) {
    console.log('  SKIP: no candidate row to rebuild from.');
    return null;
  }

  const name = candidate.name || candidate.fullName || email.split('@')[0];
  const originalUserId = await findOriginalUserId(name);
  if (originalUserId) {
    const idExists = await User.findById(originalUserId).lean();
    if (idExists) {
      console.log(`  SKIP: original _id=${originalUserId} already in users.`);
      return null;
    }
  }

  const role = await Role.findOne({ name: new RegExp(`^${escapeRegex(roleName)}$`, 'i') }).lean();
  const roleIds = role ? [role._id] : [];

  const doc = {
    name,
    email,
    isEmailVerified: true,
    status: 'pending',
    roleIds,
    registrationSource: candidate.registrationSource || 'public_candidate',
  };
  if (originalUserId) {
    try {
      doc._id = new mongoose.Types.ObjectId(originalUserId);
    } catch {
      // bad id from logs, let Mongo assign new
    }
  }
  for (const k of ['phoneNumber', 'countryCode', 'location', 'profileSummary', 'education', 'domain']) {
    if (candidate[k] != null) doc[k] = candidate[k];
  }

  console.log(`  PLAN:`);
  console.log(`    _id:       ${doc._id || '(new)'}`);
  console.log(`    name:      ${doc.name}`);
  console.log(`    email:     ${doc.email}`);
  console.log(`    roleIds:   ${doc.roleIds.map(String).join(', ') || `(none - "${roleName}" Role doc not found)`}`);
  console.log(`    status:    ${doc.status}`);
  console.log(`    candidate: ${candidate._id}  (preserved)`);

  return { doc, candidate };
}

async function main() {
  console.log(`Connecting to ${MONGO_URL.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  console.log(`Mode: ${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`Emails: ${emails.join(', ')}`);
  console.log(`Role to assign: "${roleName}"`);

  await mongoose.connect(MONGO_URL);
  const User = await loadUserModel();

  const plans = [];
  for (const email of emails) {
    try {
      const p = await planOne(User, email);
      if (p) plans.push({ email, ...p });
    } catch (err) {
      console.error(`Plan error for ${email}: ${err.message}`);
    }
  }

  if (!apply) {
    console.log(`\nDRY-RUN. ${plans.length} row(s) would be inserted. Add --apply to execute.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nInserting ${plans.length} row(s)...`);
  let ok = 0;
  for (const { email, doc } of plans) {
    try {
      const tempPassword = genPassword();
      const created = await User.create({ ...doc, password: tempPassword });
      console.log(`  OK  ${email}  _id=${created._id}  tempPassword=<hidden; user must reset>`);
      ok += 1;
    } catch (err) {
      console.error(`  FAIL  ${email}  ${err.message}`);
    }
  }
  console.log(`\nApplied: inserted=${ok} failed=${plans.length - ok}`);
  console.log(`\nNext step: send password-reset emails to:\n  ${plans.map((p) => p.email).join('\n  ')}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
