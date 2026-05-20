import dotenv from 'dotenv';
import mongoose from 'mongoose';
import TeamMember, { buildRoleSnapshot } from '../../src/models/team.model.js';
import TeamGroup from '../../src/models/teamGroup.model.js';
import Employee from '../../src/models/employee.model.js';
import Position from '../../src/models/position.model.js';
import { normalizeEmail } from '../../src/utils/normalizeEmail.js';

dotenv.config();

export const MIGRATION_VERSION = '2026-05-20-unified-workforce-A1';
export const BATCH_SIZE = 500;

export const ENUM_TO_TEAM_NAME = {
  team_ui: 'UI Team',
  team_react: 'React Team',
  team_testing: 'Testing Team',
};

/** Expand-only migration: a row is done once the `a1MigratedAt` marker is set. */
export const isAlreadyMigrated = (row) => row.a1MigratedAt != null;

/** @param {number} candidateCount @returns {('no_email_match'|'ambiguous_match'|null)} */
export const decideOrphanReason = (candidateCount) => {
  if (candidateCount === 0) return 'no_email_match';
  if (candidateCount === 1) return null;
  return 'ambiguous_match';
};

/** Captures only the reversible legacy fields, for the migration_log. */
export const buildBeforeFingerprint = (row) => ({
  name: row.name,
  email: row.email,
  position: row.position,
  teamGroup: row.teamGroup,
});

const preFlight = async () => {
  if (TeamGroup.collection.collectionName !== 'teamgroups') {
    throw new Error(
      `MIGRATION_PRECHECK_FAILED: Team model wired to "${TeamGroup.collection.collectionName}", expected "teamgroups"`
    );
  }
  const raw = mongoose.connection.collection('teammembers');
  return {
    migrationVersion: MIGRATION_VERSION,
    teamMemberRowsScanned: await raw.countDocuments({}),
    rowsPending: await raw.countDocuments({ a1MigratedAt: { $exists: false } }),
    distinctTeamGroupValues: (await raw.distinct('teamGroup')).filter(Boolean),
    employeesWithEmail: await Employee.countDocuments({ email: { $exists: true, $ne: '' } }),
  };
};

/** Idempotently creates the UI/React/Testing Teams; returns { enumValue: ObjectId }. */
const seedTeams = async (systemUserId) => {
  const map = {};
  for (const [enumVal, teamName] of Object.entries(ENUM_TO_TEAM_NAME)) {
    let team = await TeamGroup.findOne({ name: teamName });
    if (!team) {
      team = await TeamGroup.create({
        name: teamName,
        createdBy: systemUserId,
        source: 'manual',
        relatedPositions: [],
      });
    }
    map[enumVal] = team._id;
  }
  return map;
};

/**
 * Preloads every Employee into a Map keyed by normalized email AND
 * companyAssignedEmail — turns the per-row email match into an O(1) lookup.
 */
const buildEmployeeEmailIndex = async () => {
  const index = new Map();
  const add = (key, emp) => {
    if (!key) return;
    const list = index.get(key) || [];
    if (!list.some((e) => String(e._id) === String(emp._id))) list.push(emp);
    index.set(key, list);
  };
  const cursor = Employee.find({}, 'designation department email companyAssignedEmail').cursor();
  for await (const emp of cursor) {
    add(normalizeEmail(emp.email), emp);
    add(normalizeEmail(emp.companyAssignedEmail), emp);
  }
  return index;
};

/**
 * Pure — given the preloaded email index, decides the migration write for one row.
 */
export const buildMigrationOps = (row, { teamMap, empByEmail }) => {
  if (isAlreadyMigrated(row)) return { skipped: true };

  const update = {
    seniority: row.seniority || row.position || 'Member',
    assignmentMode: row.assignmentMode || 'manual',
    isActive: row.isActive !== false,
    removedAt: row.removedAt || null,
    teamId: teamMap[row.teamGroup] || row.teamId || null,
    a1MigratedAt: new Date(),
  };

  const emailNorm = normalizeEmail(row.email);
  const candidates = (emailNorm && empByEmail.get(emailNorm)) || [];

  if (candidates.length === 1) {
    update.employeeId = candidates[0]._id;
    update.roleSnapshot = buildRoleSnapshot(candidates[0], update.seniority);
    update.legacyName = null;
    update.legacyEmail = null;
    update.orphanReason = null;
    update.orphanDetectedAt = null;
  } else {
    update.employeeId = row.employeeId || null;
    if (!update.employeeId) {
      update.legacyName = row.name || '';
      update.legacyEmail = emailNorm || null;
      update.orphanReason = decideOrphanReason(candidates.length);
      update.orphanDetectedAt = new Date();
    }
  }

  return {
    skipped: false,
    orphan: !update.employeeId,
    op: { updateOne: { filter: { _id: row._id }, update: { $set: update } } },
    logDoc: {
      collection: 'teammembers',
      docId: row._id,
      migrationVersion: MIGRATION_VERSION,
      migratedAt: new Date(),
      beforeFingerprint: buildBeforeFingerprint(row),
      afterFingerprint: {
        employeeId: update.employeeId,
        teamId: update.teamId,
        seniority: update.seniority,
      },
    },
  };
};

const migrateTeamMembers = async ({ teamMap, empByEmail }) => {
  const raw = mongoose.connection.collection('teammembers');
  const logCol = mongoose.connection.collection('migration_log');
  const cursor = raw.find({});
  let scanned = 0;
  let migrated = 0;
  let orphans = 0;
  let skipped = 0;
  let ops = [];
  let logDocs = [];
  const flush = async () => {
    if (ops.length) await raw.bulkWrite(ops, { ordered: false });
    if (logDocs.length) await logCol.insertMany(logDocs, { ordered: false });
    ops = [];
    logDocs = [];
  };
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    scanned += 1;
    const res = buildMigrationOps(row, { teamMap, empByEmail });
    if (res.skipped) {
      skipped += 1;
      continue;
    }
    migrated += 1;
    if (res.orphan) orphans += 1;
    ops.push(res.op);
    logDocs.push(res.logDoc);
    if (ops.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { scanned, migrated, orphans, skipped };
};

const backfillDefaults = async () => {
  await Position.updateMany({ department: { $exists: false } }, { $set: { department: '' } });
  await Position.updateMany({ skillsSuggested: { $exists: false } }, { $set: { skillsSuggested: [] } });
  await TeamGroup.updateMany({ relatedPositions: { $exists: false } }, { $set: { relatedPositions: [] } });
};

const dedupeActiveLinkedRows = async () => {
  const groups = await TeamMember.aggregate([
    { $match: { isActive: true, employeeId: { $ne: null } } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: { teamId: '$teamId', employeeId: '$employeeId' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  let demoted = 0;
  for (const g of groups) {
    const [, ...rest] = g.ids;
    await TeamMember.updateMany(
      { _id: { $in: rest } },
      { $set: { isActive: false, removedAt: new Date(), removedReason: 'migration_dedupe' } }
    );
    demoted += rest.length;
  }
  return { demoted };
};

// IndexOptionsConflict (85) / IndexKeySpecsConflict (86): an equivalent-key index
// already exists (e.g. with a different collation) — the index goal is already met.
const IDX_EXISTS_CODES = new Set([85, 86]);

const ensureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (e) {
    if (IDX_EXISTS_CODES.has(e.code)) {
      console.warn(`[Migration A1] index ${JSON.stringify(keys)} already exists with different options — skipped.`);
      return;
    }
    throw e;
  }
};

const createIndexes = async () => {
  try {
    await TeamMember.collection.dropIndex('teamId_1_employeeId_1');
  } catch (e) {
    if (e.codeName !== 'IndexNotFound') throw e;
  }
  await ensureIndex(
    TeamMember.collection,
    { teamId: 1, employeeId: 1 },
    { unique: true, partialFilterExpression: { isActive: true, employeeId: { $type: 'objectId' } } }
  );
  await ensureIndex(TeamMember.collection, { teamId: 1, isActive: 1 });
  await ensureIndex(TeamMember.collection, { employeeId: 1, isActive: 1 });
  await ensureIndex(TeamGroup.collection, { relatedPositions: 1 });
  await ensureIndex(Position.collection, { department: 1 });
};

const postFlight = async () => ({
  linkedTeamMembers: await TeamMember.countDocuments({ employeeId: { $ne: null } }),
  orphanTeamMembers: await TeamMember.countDocuments({ employeeId: null }),
  seededTeams: await TeamGroup.countDocuments({}),
  migrationLogEntries: await mongoose.connection
    .collection('migration_log')
    .countDocuments({ migrationVersion: MIGRATION_VERSION }),
});

export const runMigration = async ({ dryRun = false, systemUserId } = {}) => {
  const preFlightReport = await preFlight();
  if (dryRun) return { ...preFlightReport, dryRun: true };
  if (!systemUserId) throw new Error('systemUserId required for a live migration');

  const teamMap = await seedTeams(systemUserId);
  const empByEmail = await buildEmployeeEmailIndex();
  const teamMembers = await migrateTeamMembers({ teamMap, empByEmail });
  const dedupe = await dedupeActiveLinkedRows();
  await backfillDefaults();
  await createIndexes();
  const post = await postFlight();

  const summary = { ...preFlightReport, teamMembers, dedupe, postFlight: post, dryRun: false, completed: true };
  console.log('[Migration A1] Summary:', JSON.stringify(summary, null, 2));
  return summary;
};

export const runReverse = async () => {
  const raw = mongoose.connection.collection('teammembers');
  const res = await raw.updateMany(
    { a1MigratedAt: { $exists: true } },
    {
      $unset: {
        a1MigratedAt: '',
        isActive: '',
        removedAt: '',
        removedReason: '',
        roleSnapshot: '',
        legacyName: '',
        legacyEmail: '',
        orphanReason: '',
        orphanDetectedAt: '',
      },
    }
  );
  console.log(`[Migration A1 REVERSE] cleared A1-added fields on ${res.modifiedCount} rows.`);
  return { reverted: res.modifiedCount };
};

if (process.argv[1] && process.argv[1].endsWith('2026-05-20-unified-workforce-A1.js')) {
  const dryRun = process.argv.includes('--dry-run');
  const reverse = process.argv.includes('--reverse');
  (async () => {
    await mongoose.connect(process.env.MONGODB_URL);
    try {
      if (reverse) {
        console.log(JSON.stringify(await runReverse(), null, 2));
      } else if (dryRun) {
        // Dry-run is pre-flight only (runMigration returns before systemUserId is used) — no system user needed.
        console.log(JSON.stringify(await runMigration({ dryRun: true }), null, 2));
      } else {
        const User = (await import('../../src/models/user.model.js')).default;
        let sys = await User.findOne({ email: 'system-migration@dharwin.local' });
        if (!sys) {
          sys = await User.create({
            name: 'System Migration',
            email: 'system-migration@dharwin.local',
            password: `Mig-${Date.now()}!`,
          });
        }
        console.log(JSON.stringify(await runMigration({ dryRun: false, systemUserId: sys._id }), null, 2));
      }
    } finally {
      await mongoose.disconnect();
    }
  })();
}
