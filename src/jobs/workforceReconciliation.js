import mongoose from 'mongoose';
import TeamMember, { buildRoleSnapshot } from '../models/team.model.js';
import TeamGroup from '../models/teamGroup.model.js';
import Employee from '../models/employee.model.js';
import Position from '../models/position.model.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';
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
    const emailNorm = normalizeEmail(tm.legacyEmail);
    if (!emailNorm) continue;
    const candidates = await Employee.find({
      $or: [{ email: emailNorm }, { companyAssignedEmail: emailNorm }],
    });
    if (candidates.length === 1) {
      tm.employeeId = candidates[0]._id;
      tm.roleSnapshot = buildRoleSnapshot(candidates[0], tm.seniority);
      tm.legacyName = null;
      tm.legacyEmail = null;
      tm.orphanReason = null;
      tm.orphanDetectedAt = null;
      await tm.save();
      linked += 1;
    }
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

export const runAllReconciliation = async () => {
  for (const job of [
    reconcileDeletedEmployees,
    pruneDanglingRelatedPositions,
    detectInactiveEmployeesInTeams,
    retryOrphanMatch,
  ]) {
    try {
      await job();
    } catch (e) {
      logger.error(`workforceReconciliation.${job.name} failed`, e);
    }
  }
};
