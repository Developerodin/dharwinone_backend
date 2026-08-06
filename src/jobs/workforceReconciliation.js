import mongoose from 'mongoose';
import TeamMember, { buildRoleSnapshot } from '../models/team.model.js';
import TeamGroup from '../models/teamGroup.model.js';
import Employee from '../models/employee.model.js';
import Position from '../models/position.model.js';
import User from '../models/user.model.js';
import { findUniqueEmployeeByEmail } from '../services/team.service.js';
import { computeIdentityConvergence, SYNTHETIC_EMAIL_RE } from '../utils/identityFields.js';
import logger from '../config/logger.js';

const LOG_COLLECTION = 'reconciliation_log';

const writeLog = async (job, summary) => {
  await mongoose.connection.collection(LOG_COLLECTION).insertOne({ job, summary, ranAt: new Date() });
};

/** Pure: keeps only ids that appear in existingIds. */
export const pruneMissingIds = (ids, existingIds) => {
  const keep = new Set((existingIds || []).map(String));
  return (ids || []).filter((id) => keep.has(String(id)));
};

/** Flips TeamMember rows whose Employee FK no longer resolves into orphan rows. */
export const reconcileDeletedEmployees = async () => {
  let flipped = 0;
  const rows = await TeamMember.find({ employeeId: { $ne: null } });
  for (const tm of rows) {
    const exists = await Employee.exists({ _id: tm.employeeId });
    if (!exists) {
      tm.employeeId = null;
      tm.orphanReason = 'employee_deleted';
      tm.orphanDetectedAt = new Date();
      await tm.save();
      flipped += 1;
    }
  }
  await writeLog('reconcileDeletedEmployees', { flipped });
  return { flipped };
};

/** Removes deleted Position FKs from Team.relatedPositions. */
export const pruneDanglingRelatedPositions = async () => {
  let pruned = 0;
  const teams = await TeamGroup.find({ 'relatedPositions.0': { $exists: true } });
  for (const team of teams) {
    const existing = await Position.find({ _id: { $in: team.relatedPositions } }).distinct('_id');
    const kept = pruneMissingIds(team.relatedPositions, existing);
    if (kept.length !== team.relatedPositions.length) {
      pruned += team.relatedPositions.length - kept.length;
      team.relatedPositions = kept;
      await team.save();
    }
  }
  await writeLog('pruneDanglingRelatedPositions', { pruned });
  return { pruned };
};

/** Links orphan rows whose legacyEmail now resolves to exactly one Employee. */
export const retryOrphanMatch = async () => {
  let linked = 0;
  const orphans = await TeamMember.find({ employeeId: null, isActive: true });
  for (const tm of orphans) {
    const emp = await findUniqueEmployeeByEmail(tm.legacyEmail);
    if (!emp) continue;
    tm.employeeId = emp._id;
    tm.roleSnapshot = buildRoleSnapshot(emp, tm.seniority);
    tm.legacyName = null;
    tm.legacyEmail = null;
    tm.orphanReason = null;
    tm.orphanDetectedAt = null;
    await tm.save();
    linked += 1;
  }
  await writeLog('retryOrphanMatch', { linked });
  return { linked };
};

/** Soft-removes roster rows whose linked Employee is inactive. */
export const detectInactiveEmployeesInTeams = async () => {
  let removed = 0;
  const rows = await TeamMember.find({ employeeId: { $ne: null }, isActive: true }).populate(
    'employeeId',
    'isActive'
  );
  for (const tm of rows) {
    if (tm.employeeId && tm.employeeId.isActive === false) {
      tm.isActive = false;
      tm.removedAt = new Date();
      tm.removedReason = 'employee_inactive';
      tm.employeeId = tm.employeeId._id;
      await tm.save();
      removed += 1;
    }
  }
  await writeLog('detectInactiveEmployeesInTeams', { removed });
  return { removed };
};

/** Converges User↔Employee identity mirror: User non-empty wins down, empty adopts up. */
export const reconcileIdentityMirror = async () => {
  let usersUpdated = 0;
  let employeesUpdated = 0;
  let skipped = 0;
  // Owners holding several real profiles have no decidable mirror target — converging them
  // would stamp one User's identity onto every profile and break candidates.email uniqueness.
  // Only the profile matching the User's own email converges; the rest are skipped.
  const ambiguousOwners = new Set(
    (
      await Employee.aggregate([
        { $match: { owner: { $ne: null }, email: { $not: SYNTHETIC_EMAIL_RE } } },
        { $group: { _id: '$owner', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
    ).map((g) => String(g._id))
  );
  const cursor = Employee.find({ owner: { $ne: null } })
    .select('owner fullName email phoneNumber countryCode profilePicture')
    .lean()
    .cursor();
  for await (const emp of cursor) {
    if (SYNTHETIC_EMAIL_RE.test(emp.email || '')) {
      skipped += 1;
      continue;
    }
    const user = await User.findById(emp.owner)
      .select('name email phoneNumber countryCode profilePicture')
      .lean();
    if (!user) continue;
    if (
      ambiguousOwners.has(String(emp.owner)) &&
      String(emp.email || '').toLowerCase() !== String(user.email || '').toLowerCase()
    ) {
      skipped += 1;
      continue;
    }
    const { userSet, employeeSet } = computeIdentityConvergence(user, emp);
    // Same defensive rule as the backfill script: never adopt email/name upward
    // (updateOne bypasses isEmailTaken and schema validation).
    delete userSet.email;
    delete userSet.name;
    if (Object.keys(userSet).length) {
      await User.updateOne({ _id: user._id }, { $set: userSet });
      usersUpdated += 1;
    }
    if (Object.keys(employeeSet).length) {
      await Employee.updateOne({ _id: emp._id }, { $set: employeeSet });
      employeesUpdated += 1;
    }
  }
  await writeLog('reconcileIdentityMirror', { usersUpdated, employeesUpdated, skipped });
  return { usersUpdated, employeesUpdated, skipped };
};

export const runAllReconciliation = async () => {
  for (const job of [
    reconcileDeletedEmployees,
    pruneDanglingRelatedPositions,
    detectInactiveEmployeesInTeams,
    retryOrphanMatch,
    reconcileIdentityMirror,
  ]) {
    try {
      await job();
    } catch (e) {
      logger.error(`workforceReconciliation.${job.name} failed`, e);
    }
  }
};
