import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import logger from '../config/logger.js';
import { getRoleByName } from './role.service.js';

/** UTC calendar day YYYY-MM-DD for comparisons (matches placement / offer date handling). */
export const joinDateYmdUtc = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return x.toISOString().slice(0, 10);
};

/**
 * True when the candidate's joining calendar day (UTC) is today or in the past.
 * @param {Date|string|null|undefined} joiningDate - From Employee profile (offer / HRMS).
 * @returns {boolean}
 */
export const joinCalendarDayHasArrived = (joiningDate) => {
  if (joiningDate == null || joiningDate === '') return false;
  const j = joinDateYmdUtc(joiningDate);
  if (!j) return false;
  const t = joinDateYmdUtc(new Date());
  return j <= t;
};

let cachedRolePair = null;

async function resolveCandidateAndEmployeeRoles() {
  if (cachedRolePair) return cachedRolePair;
  const candidateRole = await getRoleByName('Candidate');
  const employeeRole = await getRoleByName('Employee');
  // Only cache when both roles exist — avoids serving a stale null
  // if roles were not yet seeded at startup.
  if (candidateRole && employeeRole) {
    cachedRolePair = { candidateRole, employeeRole };
  }
  return { candidateRole, employeeRole };
}

/**
 * On the joining date (or after), replace the legacy **Candidate** user role with **Employee**
 * for the account that owns the candidate profile. Uses **Employee.joiningDate** as the single
 * source of truth — same field used in HRMS / employees list.
 *
 * Idempotent: no-op if Candidate role is missing, Employee role is missing, or user already has Employee.
 *
 * @param {import('mongoose').Types.ObjectId|string} ownerUserId - User who owns the Employee (candidate) profile
 * @returns {Promise<boolean>} true if DB was updated
 */
export async function promoteCandidateOwnerToEmployeeRole(ownerUserId) {
  if (!ownerUserId) return false;
  const { candidateRole, employeeRole } = await resolveCandidateAndEmployeeRoles();

  if (!employeeRole) {
    logger.warn('[employeeRolePromotion] Employee role not found — cannot promote from Candidate');
    return false;
  }

  const emp = await Employee.findOne({ owner: ownerUserId }).select('joiningDate').lean();
  if (!emp?.joiningDate) return false;
  if (!joinCalendarDayHasArrived(emp.joiningDate)) {
    // Joining date is in the future — scheduler will promote on the correct day.
    logger.debug(
      `[employeeRolePromotion] Skipping promotion for user ${ownerUserId} — joining date ${joinDateYmdUtc(emp.joiningDate)} not yet arrived`
    );
    return false;
  }

  const uid = String(ownerUserId);
  const user = await User.findById(ownerUserId).select('roleIds').lean();
  if (!user?.roleIds?.length) return false;

  const empRoleId = String(employeeRole._id);
  const hasEmployee = user.roleIds.some((id) => String(id) === empRoleId);

  const candId = candidateRole?._id;
  const hasCandidate = candId && user.roleIds.some((id) => String(id) === String(candId));

  // Already using Employee role; drop legacy Candidate if both are present.
  if (hasEmployee) {
    if (hasCandidate && candId) {
      await User.updateOne({ _id: ownerUserId }, { $pull: { roleIds: candId } });
      const Student = (await import('../models/student.model.js')).default;
      await Student.updateMany({ user: ownerUserId }, { $set: { joiningDate: emp.joiningDate } });
      logger.info(`[employeeRolePromotion] Removed duplicate Candidate role for user ${uid}`);
      return true;
    }
    return false;
  }

  if (!hasCandidate || !candId) {
    return false;
  }

  // MongoDB does not allow $pull and $addToSet on the same path in one operation.
  // Add Employee role first so the user is never left with zero roles.
  await User.updateOne(
    { _id: ownerUserId },
    { $addToSet: { roleIds: employeeRole._id } }
  );
  await User.updateOne(
    { _id: ownerUserId },
    { $pull: { roleIds: candId } }
  );
  const Student = (await import('../models/student.model.js')).default;
  await Student.updateMany({ user: ownerUserId }, { $set: { joiningDate: emp.joiningDate } });
  logger.info(
    `[employeeRolePromotion] Candidate → Employee role for user ${uid} (joiningDate=${joinDateYmdUtc(emp.joiningDate)})`
  );
  return true;
}

/**
 * Batch: all candidate owners whose joining date has arrived may be promoted (scheduler).
 * @returns {Promise<number>} number of users updated
 */
export async function promoteAllEligibleCandidateOwnersFromScheduler() {
  const { employeeRole } = await resolveCandidateAndEmployeeRoles();
  if (!employeeRole) return 0;

  // Only fetch employees whose joining date has arrived (today or past).
  // This avoids scanning the entire collection on every scheduler tick.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await Employee.find({
    owner: { $exists: true, $ne: null },
    joiningDate: { $exists: true, $ne: null, $lte: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1) },
  })
    .select('owner joiningDate')
    .lean();

  let updated = 0;
  for (const row of rows) {
    if (!joinCalendarDayHasArrived(row.joiningDate)) continue;
    // eslint-disable-next-line no-await-in-loop
    const did = await promoteCandidateOwnerToEmployeeRole(row.owner);
    if (did) updated += 1;
  }
  return updated;
}
