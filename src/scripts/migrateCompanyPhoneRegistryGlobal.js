// src/scripts/migrateCompanyPhoneRegistryGlobal.js
/**
 * CompanyPhoneNumber -> one shared company registry.
 *
 * Retires duplicate local rows pointing at ONE provider resource (same provider +
 * twilioSid), keeping the row that carries the assignment, then creates the partial-unique
 * {provider, twilioSid} index so a duplicate cannot come back.
 *
 *   npm run migrate:phone-registry:dry      # read-only analysis (DEFAULT behaviour)
 *   npm run migrate:phone-registry          # writes (passes --apply)
 *   node src/scripts/migrateCompanyPhoneRegistryGlobal.js --rollback <snapshot.json> --dry
 *   node src/scripts/migrateCompanyPhoneRegistryGlobal.js --rollback <snapshot.json> --apply
 *
 * Touches ONLY the companyphonenumbers collection. Never reads or writes User documents,
 * User.adminId or User.tenantId. Never alters assignedTo, twilioSid, phoneNumber, provider.
 *
 * Legacy tenantId+phoneNumber index intentionally retained for later tenant cleanup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import config from '../config/config.js';

export const MIGRATION_ID = '2026-08-26-company-phone-registry-global';
export const INDEX_KEY = { provider: 1, twilioSid: 1 };
export const INDEX_PARTIAL = { twilioSid: { $type: 'string', $gt: '' }, isActive: true };
/** Everything the migration may touch, so a snapshot can fully restore a row. */
export const SNAPSHOT_FIELDS = [
  '_id',
  'tenantId',
  'phoneNumber',
  'twilioSid',
  'provider',
  'assignedTo',
  'isActive',
  'retiredAt',
  'retiredReason',
];

const COLLECTION = 'companyphonenumbers';
const RETIRED_REASON = 'duplicate provider resource (same twilioSid)';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'scripts', 'backups');

const S = (v) => (v == null ? null : String(v));

// ---------------------------------------------------------------- pure planning

/** Snapshot pre-image of a row: only the fields this migration can change. */
export const snapshotRow = (row) =>
  Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, f === '_id' ? S(row._id) : (row[f] ?? null)]));

/**
 * Decide what to retire. Groups ACTIVE rows by provider resource.
 *
 *   1 assigned + N unassigned      -> keep the assigned row, retire the unassigned ones
 *   all unassigned                 -> keep the oldest, retire the rest (no assignment at stake)
 *   2+ assigned to DIFFERENT users -> AMBIGUOUS: never choose between two people
 *
 * SID-less rows are excluded entirely: without a provider identity there is nothing
 * authoritative to dedupe on, so they are reported and preserved.
 */
export function planMigration(rows) {
  const active = rows.filter((r) => r.isActive !== false);
  const sidless = {
    active: active.filter((r) => !r.twilioSid).length,
    retired: rows.filter((r) => r.isActive === false && !r.twilioSid).length,
  };

  const groups = new Map();
  for (const r of active) {
    if (!r.twilioSid) continue;
    const key = `${r.provider}|${r.twilioSid}`;
    groups.set(key, [...(groups.get(key) || []), r]);
  }

  const safe = [];
  const ambiguous = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const assignees = [...new Set(group.filter((r) => r.assignedTo).map((r) => S(r.assignedTo)))];
    if (assignees.length > 1) {
      ambiguous.push({ key, provider: group[0].provider, twilioSid: group[0].twilioSid, rows: group, assignees });
      continue;
    }
    const survivor =
      group.find((r) => r.assignedTo) ||
      [...group].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0];
    for (const r of group) {
      if (S(r._id) === S(survivor._id)) continue;
      safe.push({ key, survivor, row: r });
    }
  }

  return { groups, safe, ambiguous, sidless, scanned: rows.length };
}

// ---------------------------------------------------------------- target guard

/** DRY RUN unless --apply is given explicitly. --dry / --dry-run are accepted aliases. */
export function resolveRunMode(argv = []) {
  const rollbackAt = argv.indexOf('--rollback');
  return {
    apply: argv.includes('--apply'),
    dryExplicit: argv.includes('--dry') || argv.includes('--dry-run'),
    rollback: rollbackAt > -1,
    snapshotPath: rollbackAt > -1 ? argv[rollbackAt + 1] : null,
    confirmProduction: argv.includes('--confirm-production'),
  };
}

/**
 * Refuse to run against an environment we cannot name, and refuse to WRITE to production
 * without an explicit extra flag — a mistaken terminal must not be able to mutate prod.
 */
export function assertSafeTarget({ env, database, apply, confirmProduction }) {
  if (!env) throw new Error('Refusing to run: NODE_ENV / config.env is not set.');
  if (!database) throw new Error('Refusing to run: could not resolve the target database name from MONGODB_URL.');
  if (env === 'production' && apply && !confirmProduction) {
    throw new Error(
      `Refusing to write to PRODUCTION database "${database}" without --confirm-production. ` +
        'Re-run with --dry first, review the plan, then add --confirm-production.',
    );
  }
  return true;
}

/** Database name from the connection string — no environment name is hardcoded. */
export function databaseNameFromUrl(url) {
  try {
    const withoutQuery = String(url).split('?')[0];
    const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1).trim();
    return name || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- index helpers

/** Find our index by KEY SHAPE, so a renamed index is still located. */
export async function findResourceIndex(col) {
  const indexes = await col.indexes();
  return (
    indexes.find((i) => i.key?.provider === 1 && i.key?.twilioSid === 1 && Object.keys(i.key).length === 2) || null
  );
}

/** Create if absent, then assert it really is unique + partial. Throws on any failure. */
export async function ensureResourceIndex(col) {
  let existing = await findResourceIndex(col);
  if (!existing) {
    await col.createIndex(INDEX_KEY, { unique: true, partialFilterExpression: INDEX_PARTIAL });
    existing = await findResourceIndex(col);
  }
  if (!existing) throw new Error('Index verification failed: provider+twilioSid index absent after createIndex.');
  if (!existing.unique) throw new Error(`Index verification failed: ${existing.name} is not unique.`);
  const partial = JSON.stringify(existing.partialFilterExpression || null);
  if (partial !== JSON.stringify(INDEX_PARTIAL)) {
    throw new Error(
      `Index verification failed: ${existing.name} partial filter is ${partial}, expected ${JSON.stringify(INDEX_PARTIAL)}.`,
    );
  }
  return existing;
}

// ---------------------------------------------------------------- validation (§15 A-J)

export function validateAfterApply({ rowsAfter, snapshot, indexInfo }) {
  const failures = [];
  const byId = new Map(rowsAfter.map((r) => [S(r._id), r]));

  const activeGroups = new Map();
  const activePhone = new Map();
  for (const r of rowsAfter.filter((x) => x.isActive !== false && x.twilioSid)) {
    const k = `${r.provider}|${r.twilioSid}`;
    activeGroups.set(k, (activeGroups.get(k) || 0) + 1);
    const p = `${r.provider}|${r.phoneNumber}`;
    activePhone.set(p, (activePhone.get(p) || 0) + 1);
  }
  for (const [k, n] of activeGroups) if (n > 1) failures.push(`A: ${n} active rows share provider resource ${k}`);
  for (const [k, n] of activePhone) if (n > 1) failures.push(`B: ${n} active rows share provider+phoneNumber ${k}`);

  for (const pre of snapshot.rows) {
    const live = byId.get(pre._id);
    if (!live) {
      failures.push(`C: retired row ${pre._id} disappeared`);
      continue;
    }
    if (S(live.assignedTo) !== S(pre.assignedTo)) failures.push(`D: assignedTo changed on ${pre._id}`);
    if (live.phoneNumber !== pre.phoneNumber) failures.push(`E: phoneNumber changed on ${pre._id}`);
    if (live.twilioSid !== pre.twilioSid) failures.push(`F: twilioSid changed on ${pre._id}`);
    if (live.provider !== pre.provider) failures.push(`G: provider changed on ${pre._id}`);
    const survivors = rowsAfter.filter(
      (r) => r.isActive !== false && r.provider === pre.provider && r.twilioSid === pre.twilioSid,
    );
    if (survivors.length !== 1) failures.push(`C: retired ${pre._id} has ${survivors.length} active survivors (expected 1)`);
  }

  if (!indexInfo) failures.push('J: provider+twilioSid index missing');
  else if (!indexInfo.unique) failures.push('J: provider+twilioSid index is not unique');
  else if (JSON.stringify(indexInfo.partialFilterExpression || null) !== JSON.stringify(INDEX_PARTIAL)) {
    failures.push('J: provider+twilioSid partial filter does not match');
  }

  return failures;
}

// ---------------------------------------------------------------- apply / rollback

export async function runApply({ col, rows, dryRun, log, writeSnapshot }) {
  const plan = planMigration(rows);

  log(`Records scanned: ${plan.scanned}`);
  log(`Active duplicate provider+SID groups: ${new Set(plan.safe.map((s) => s.key)).size + plan.ambiguous.length}`);
  log(`Safe duplicate retirements: ${plan.safe.length}`);
  log(`Ambiguous groups: ${plan.ambiguous.length}`);
  log(`SID-less records: active=${plan.sidless.active} retired=${plan.sidless.retired} (excluded from dedup, preserved)`);

  if (plan.ambiguous.length) {
    log('\nAMBIGUOUS — manual review required. Nothing was modified.');
    for (const a of plan.ambiguous) {
      log(`  provider=${a.provider} twilioSid=${a.twilioSid} rows=${a.rows.length} assignees=${a.assignees.length}`);
      for (const r of a.rows) {
        log(`    _id=${S(r._id)} phone=${r.phoneNumber} assignedTo=${S(r.assignedTo) || '(unassigned)'} isActive=${r.isActive}`);
      }
    }
    throw new Error(`Refusing to continue: ${plan.ambiguous.length} ambiguous duplicate group(s) need a human decision.`);
  }

  log('\nPlanned:');
  for (const { survivor, row } of plan.safe) {
    log(`  KEEP    _id=${S(survivor._id)} phone=${survivor.phoneNumber} assignedTo=${S(survivor.assignedTo) || '(unassigned)'}`);
    log(`  RETIRE  _id=${S(row._id)} phone=${row.phoneNumber} assignedTo=${S(row.assignedTo) || '(unassigned)'} -> isActive=false`);
  }
  if (!plan.safe.length) log('  (nothing to retire)');

  if (dryRun) {
    log('\nNo data modified.');
    return { plan, retired: 0, snapshotPath: null, indexInfo: await findResourceIndex(col), snapshot: null };
  }

  const snapshot = {
    migration: MIGRATION_ID,
    takenAt: new Date().toISOString(),
    rows: plan.safe.map(({ row }) => snapshotRow(row)),
  };
  const snapshotPath = await writeSnapshot(snapshot);
  log(`\nSnapshot: ${snapshotPath}`);

  let retired = 0;
  for (const { row } of plan.safe) {
    await col.updateOne(
      { _id: row._id },
      { $set: { isActive: false, retiredAt: new Date(), retiredReason: RETIRED_REASON } },
    );
    retired += 1;
  }

  const indexInfo = await ensureResourceIndex(col);
  return { plan, retired, snapshotPath, indexInfo, snapshot };
}

export async function runRollback({ col, snapshot, dryRun, log }) {
  if (snapshot?.migration !== MIGRATION_ID) {
    throw new Error(`Snapshot is for "${snapshot?.migration}", not ${MIGRATION_ID}. Refusing to roll back.`);
  }
  if (!Array.isArray(snapshot.rows)) throw new Error('Snapshot has no rows[].');
  for (const r of snapshot.rows) {
    for (const f of SNAPSHOT_FIELDS) {
      if (!(f in r)) throw new Error(`Snapshot row ${r._id} is missing "${f}" — cannot restore safely.`);
    }
  }
  log(`Snapshot validated: ${snapshot.rows.length} row(s) from ${snapshot.takenAt}`);

  const before = await findResourceIndex(col);
  log(`Index present: ${before ? before.name : '(none)'}`);
  log('Steps: drop provider+twilioSid index -> restore rows -> recreate index -> verify');

  if (dryRun) {
    log('\nDRY RUN — no data modified.');
    return { restored: 0, indexInfo: before };
  }

  // Restoring reactivates a row that shares a SID with its survivor, which the unique
  // partial index forbids — so the index comes down first and goes straight back up.
  if (before) {
    await col.dropIndex(before.name);
    log(`dropped ${before.name}`);
  }

  let restored = 0;
  try {
    for (const r of snapshot.rows) {
      const $set = { isActive: r.isActive };
      const $unset = {};
      if (r.retiredAt == null) $unset.retiredAt = '';
      else $set.retiredAt = r.retiredAt;
      if (r.retiredReason == null) $unset.retiredReason = '';
      else $set.retiredReason = r.retiredReason;
      // Cast only when it really is an ObjectId — a snapshot must never crash the restore.
      const id = mongoose.isValidObjectId(r._id) ? new mongoose.Types.ObjectId(String(r._id)) : r._id;
      await col.updateOne({ _id: id }, Object.keys($unset).length ? { $set, $unset } : { $set });
      restored += 1;
      log(`restored ${r._id} isActive=${r.isActive}`);
    }
  } finally {
    // Always put the index back, even if a restore threw — never leave prod unprotected.
    const after = await ensureResourceIndex(col);
    log(`index restored: ${after.name}`);
  }

  if (restored !== snapshot.rows.length) {
    throw new Error(`Rollback incomplete: restored ${restored}/${snapshot.rows.length}.`);
  }
  return { restored, indexInfo: await findResourceIndex(col) };
}

// ---------------------------------------------------------------- CLI

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const main = async () => {
  const mode = resolveRunMode(process.argv);
  const dryRun = !mode.apply;
  const database = databaseNameFromUrl(config.mongoose.url);

  console.log(`Environment: ${String(config.env || '').toUpperCase() || '(unset)'}`);
  console.log(`Database:    ${database || '(unresolved)'}`);
  console.log(`Mode:        ${mode.rollback ? 'ROLLBACK ' : ''}${dryRun ? 'DRY RUN' : 'APPLY'}\n`);
  assertSafeTarget({ env: config.env, database, apply: mode.apply, confirmProduction: mode.confirmProduction });

  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const col = mongoose.connection.db.collection(COLLECTION);
  const log = (m) => console.log(m);

  try {
    if (mode.rollback) {
      if (!mode.snapshotPath) throw new Error('--rollback needs a snapshot path.');
      const snapshot = JSON.parse(fs.readFileSync(path.resolve(mode.snapshotPath), 'utf8'));
      const res = await runRollback({ col, snapshot, dryRun, log });
      console.log(`\nRollback ${dryRun ? 'plan OK — no data modified' : `completed: ${res.restored} row(s) restored`}.`);
      console.log(`Index: ${res.indexInfo?.name} unique=${!!res.indexInfo?.unique}`);
      return;
    }

    const rows = await col.find({}).toArray();
    const userCountBefore = await mongoose.connection.db.collection('users').countDocuments();

    const res = await runApply({
      col,
      rows,
      dryRun,
      log,
      writeSnapshot: async (snapshot) => {
        fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
        const file = path.join(SNAPSHOT_DIR, `${snapshot.takenAt.replace(/[:.]/g, '-')}-company-phone-registry.json`);
        fs.writeFileSync(file, JSON.stringify({ ...snapshot, env: config.env, database }, null, 2));
        return file;
      },
    });

    if (dryRun) return;

    console.log(`\nRetired: ${res.retired}`);
    console.log('Updated: 0');
    console.log(`Ambiguous: ${res.plan.ambiguous.length}`);
    console.log(
      `\nIndex:\n  ${res.indexInfo.name}\n  unique: ${!!res.indexInfo.unique}\n  partial: ${JSON.stringify(res.indexInfo.partialFilterExpression)}`,
    );
    console.log('  Legacy tenantId+phoneNumber index intentionally retained for later tenant cleanup.');

    const rowsAfter = await col.find({}).toArray();
    const userCountAfter = await mongoose.connection.db.collection('users').countDocuments();
    const failures = validateAfterApply({ rowsAfter, snapshot: res.snapshot, indexInfo: res.indexInfo });
    if (userCountAfter !== userCountBefore) failures.push('H: user document count changed — this migration must never touch users');

    if (failures.length) {
      console.error(`\nValidation: FAIL\n  ${failures.join('\n  ')}`);
      throw new Error('Post-migration validation failed.');
    }
    console.log('\nValidation: PASS (A-J)');
    console.log(`Rollback with: node src/scripts/migrateCompanyPhoneRegistryGlobal.js --rollback ${res.snapshotPath} --apply`);
    console.log('\nMigration completed successfully.');
  } finally {
    await mongoose.disconnect();
  }
};

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\nMIGRATION FAILED: ${err.message}`);
    process.exit(1);
  });
}
