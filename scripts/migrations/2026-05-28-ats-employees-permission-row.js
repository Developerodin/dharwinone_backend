/* eslint-disable no-console */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Role from '../../src/models/role.model.js';
import { permissionAliases } from '../../src/config/permissions.js';
import { bustRoleRegistry } from '../../src/services/chatAssistant/roleRegistry.js';

dotenv.config();

export const MIGRATION_VERSION = '2026-05-28-ats-employees-permission-row';
export const BATCH_SIZE = 500;
export const MAX_RETRY_PER_ROLE = 3;
export const BSON_SIZE_BUDGET_BYTES = 12 * 1024 * 1024;

export const ATS_CANDIDATES_PREFIX = 'ats.candidates:';
export const ATS_EMPLOYEES_PREFIX = 'ats.employees:';

export const DEPRECATED_KEYS = new Set([
  'candidates.joiningDate',
  'candidates.joiningDate.read',
  'candidates.joiningDate.manage',
  'candidates.resignDate',
  'candidates.resignDate.read',
  'candidates.resignDate.manage',
]);

export const DEPRECATED_RAW_PREFIXES = [
  'ats.candidates.joiningDate:',
  'ats.candidates.resignDate:',
];

const ACTION_ORDER = ['view', 'create', 'edit', 'delete'];

export const normalizeActions = (s) => {
  const idx = s.indexOf(':');
  if (idx < 0) return s;
  const feature = s.slice(0, idx);
  const actionsRaw = s.slice(idx + 1).split(',').map((a) => a.trim()).filter(Boolean);
  if (!actionsRaw.length) return `${feature}:`;
  const sorted = [...new Set(actionsRaw)]
    .sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  return `${feature}:${sorted.join(',')}`;
};

export const arrayEqualUnordered = (a, b) => {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
};

/**
 * Pure transform. Given current Role.permissions, return next array + added/removed.
 */
export const migrateRole = (originalPermissions) => {
  const next = new Set();
  const added = [];
  const removed = [];

  for (const p of originalPermissions) {
    if (DEPRECATED_KEYS.has(p)) {
      removed.push(p);
      continue;
    }
    if (DEPRECATED_RAW_PREFIXES.some((prefix) => p.startsWith(prefix))) {
      removed.push(p);
      continue;
    }
    next.add(p);
  }

  for (const p of originalPermissions) {
    if (!p.startsWith(ATS_CANDIDATES_PREFIX)) continue;
    if (DEPRECATED_RAW_PREFIXES.some((prefix) => p.startsWith(prefix))) continue;

    const rawMirror = ATS_EMPLOYEES_PREFIX + p.slice(ATS_CANDIDATES_PREFIX.length);
    const mirror = normalizeActions(rawMirror);
    if (!next.has(mirror)) {
      next.add(mirror);
      added.push(mirror);
    }
  }

  return { next: [...next], added, removed };
};

export const projectMigrationLogSize = (previousPermissions, nextPermissions) => {
  const payload = JSON.stringify({
    version: MIGRATION_VERSION,
    previousPermissions,
    nextPermissions,
    addedKeys: nextPermissions,
    removedKeys: previousPermissions,
  });
  return Buffer.byteLength(payload, 'utf8');
};

export const runForward = async ({ dryRun = false } = {}) => {
  const migrationLog = mongoose.connection.collection('migration_log');
  const summary = {
    version: MIGRATION_VERSION,
    rolesScanned: 0,
    rolesMutated: 0,
    rolesWouldMutate: 0,
    unresolvedConflicts: [],
    dryRun,
    startedAt: new Date(),
  };

  let batchCounter = 0;

  for await (const role of Role.find({}).cursor()) {
    summary.rolesScanned++;
    let attempt = 0;
    let succeeded = false;

    while (attempt < MAX_RETRY_PER_ROLE && !succeeded) {
      attempt++;
      const fresh = await Role.findById(role._id).lean();
      if (!fresh) {
        succeeded = true;
        break;
      }
      const original = fresh.permissions || [];
      const { next, added, removed } = migrateRole(original);

      if (arrayEqualUnordered(original, next) && !added.length && !removed.length) {
        succeeded = true;
        break;
      }

      const projectedSize = projectMigrationLogSize(original, next);
      if (projectedSize > BSON_SIZE_BUDGET_BYTES) {
        summary.unresolvedConflicts.push({
          roleId: role._id,
          attempts: attempt,
          reason: `BSON size budget exceeded (${projectedSize} > ${BSON_SIZE_BUDGET_BYTES})`,
        });
        succeeded = true;
        break;
      }

      if (dryRun) {
        summary.rolesWouldMutate++;
        succeeded = true;
        break;
      }

      const result = await Role.updateOne(
        { _id: role._id, permissions: original },
        { $set: { permissions: next } }
      );

      if (result.modifiedCount === 1) {
        await migrationLog.insertOne({
          version: MIGRATION_VERSION,
          roleId: role._id,
          previousPermissions: original,
          nextPermissions: next,
          addedKeys: added,
          removedKeys: removed,
          attemptNumber: attempt,
          timestamp: new Date(),
        });
        summary.rolesMutated++;
        succeeded = true;
      }
    }

    if (!succeeded) {
      summary.unresolvedConflicts.push({ roleId: role._id, attempts: attempt });
    }

    if (++batchCounter >= BATCH_SIZE) {
      if (!dryRun) await bustRoleRegistry();
      batchCounter = 0;
    }
  }

  if (!dryRun) await bustRoleRegistry();
  summary.finishedAt = new Date();
  return summary;
};

export const runReverse = async () => {
  const migrationLog = mongoose.connection.collection('migration_log');
  const summary = {
    version: MIGRATION_VERSION,
    rolesRestored: 0,
    rolesSkipped: 0,
    startedAt: new Date(),
  };

  for await (const log of migrationLog
    .find({ version: MIGRATION_VERSION })
    .sort({ timestamp: -1 })
    .stream()) {
    const role = await Role.findById(log.roleId);
    if (!role) {
      console.warn(
        `[Reverse] Role ${log.roleId} no longer exists, skipping. `
        + 'Use full DB snapshot restore for this role.'
      );
      summary.rolesSkipped++;
      continue;
    }
    await Role.updateOne(
      { _id: log.roleId },
      { $set: { permissions: log.previousPermissions } }
    );
    summary.rolesRestored++;
  }

  await bustRoleRegistry();
  summary.finishedAt = new Date();
  return summary;
};

export const preFlight = async () => {
  const totalRoles = await Role.countDocuments({});
  const candidatePrefixRoles = await Role.countDocuments({
    permissions: { $regex: /^ats\.candidates:/ },
  });
  const candidateDottedSubrowRoles = await Role.countDocuments({
    permissions: { $regex: /^ats\.candidates\.(joiningDate|resignDate):/ },
  });
  const deprecatedKeyRoles = await Role.countDocuments({
    permissions: { $in: [...DEPRECATED_KEYS] },
  });

  const validLiterals = new Set(Object.keys(permissionAliases));
  for (const k of DEPRECATED_KEYS) validLiterals.add(k);

  const allRoles = await Role.find({}, { permissions: 1 }).lean();
  const unknownStrings = new Set();
  for (const r of allRoles) {
    for (const p of r.permissions || []) {
      if (!p) continue;
      const hasColon = p.includes(':');
      if (hasColon) continue;
      if (validLiterals.has(p)) continue;
      unknownStrings.add(p);
    }
  }

  return {
    version: MIGRATION_VERSION,
    totalRoles,
    candidatePrefixRoles,
    candidateDottedSubrowRoles,
    deprecatedKeyRoles,
    unknownStringsCount: unknownStrings.size,
    unknownStringsSample: [...unknownStrings].slice(0, 20),
    note: unknownStrings.size > 0
      ? 'unknownStrings is informational (not blocking). Verify they are intentional literal grants in permissionAliases or expected legacy strings.'
      : null,
  };
};

if (
  process.argv[1]
  && process.argv[1].endsWith('2026-05-28-ats-employees-permission-row.js')
) {
  const reverse = process.argv.includes('--reverse');
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URL) {
      console.error('MONGODB_URL not set in env');
      process.exit(2);
    }
    await mongoose.connect(process.env.MONGODB_URL);
    try {
      console.log('[Migration] Pre-flight:', JSON.stringify(await preFlight(), null, 2));

      if (reverse) {
        const s = await runReverse();
        console.log('[Migration] Reverse summary:', JSON.stringify(s, null, 2));
      } else {
        const s = await runForward({ dryRun });
        console.log('[Migration]', dryRun ? 'Dry-run' : 'Live', 'summary:', JSON.stringify(s, null, 2));
        if (s.unresolvedConflicts.length > 0) process.exitCode = 1;
      }
    } finally {
      await mongoose.disconnect();
    }
  })();
}
