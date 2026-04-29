import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import Placement from '../models/placement.model.js';
import Role from '../models/role.model.js';
import logger from '../config/logger.js';
import { placementCandidateHasDisplayIdentity } from '../utils/placementCandidateIdentity.js';
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

/**
 * Normalize role name for comparisons (handles odd Unicode / spaces in legacy data).
 * @param {string|undefined|null} s
 */
const normalizeRoleLabel = (s) => String(s || '').normalize('NFKC').trim().toLowerCase();

/**
 * Applicant **job-seeker** role id to remove: the Role named `Candidate` (case-insensitive, trimmed)
 * among the user's `roleIds`. Falls back to the canonical Candidate id if it appears on the user.
 * Matches how User Management resolves `rolesById.get(id)?.name` and `getRoleByName('Candidate')`.
 *
 * @param {import('mongoose').Types.ObjectId[]} userRoleIds
 * @param {import('mongoose').Document|null|undefined} canonicalCandidateRole - from {@link getRoleByName}('Candidate')
 * @returns {Promise<import('mongoose').Types.ObjectId|null>}
 */
async function resolveApplicantCandidateRoleIdForUser(userRoleIds, canonicalCandidateRole) {
  if (!userRoleIds?.length) return null;

  /** Same pattern as {@link getRoleByName} for the Job-seeker role (anchored, case-insensitive). */
  const one = await Role.findOne({
    _id: { $in: userRoleIds },
    name: { $regex: /^candidate$/i },
  })
    .select('_id name')
    .lean();
  if (one?._id) return one._id;

  const roleDocs = await Role.find({ _id: { $in: userRoleIds } })
    .select('name')
    .lean();
  const named = roleDocs.find((r) => normalizeRoleLabel(r.name) === 'candidate');
  if (named?._id) return named._id;

  const canonId = canonicalCandidateRole?._id;
  if (canonId && userRoleIds.some((id) => String(id) === String(canonId))) return canonId;
  return null;
}

let cachedRolePair = null;

async function resolveCandidateAndEmployeeRoles() {
  if (cachedRolePair) return cachedRolePair;
  const candidateRole = await getRoleByName('Candidate');
  const employeeRole = await getRoleByName('Employee');
  cachedRolePair = { candidateRole, employeeRole };
  return cachedRolePair;
}

/**
 * Applicant login User id for this Employee profile.
 * Job applies attach {@link Employee.owner} to the job creator/recruiter (`job.service`), while the Candidate
 * registers separately — {@link Employee.email} matches their login. Prefer User(email === employee.email).
 *
 * @param {{ email?: string|null, owner?: import('mongoose').Types.ObjectId|string|null }} empLean
 * @param {import('mongoose').Types.ObjectId|string|null} fallbackUserId - Usually caller-passed owner id
 * @returns {Promise<string>} User id string for role promotion / Student sync
 */
async function resolveCandidateLoginUserIdForEmployee(empLean, fallbackUserId) {
  const fb = fallbackUserId != null ? String(fallbackUserId) : '';
  const empEmailNorm = String(empLean?.email || '')
    .trim()
    .toLowerCase();
  if (!empEmailNorm) return fb;
  const loginUser = await User.findOne({ email: empEmailNorm }).select('_id').lean();
  return loginUser?._id ? String(loginUser._id) : fb;
}

/**
 * On the joining date (or after), replace the legacy **Candidate** user role with **Employee**
 * for the account that owns the candidate profile. Uses **Employee.joiningDate** as the single
 * source of truth — same field used in HRMS / employees list.
 *
 * Idempotent: no-op if Candidate role is missing, Employee role is missing, or user already has Employee.
 *
 * @param {import('mongoose').Types.ObjectId|string} ownerUserId - User who owns the Employee (candidate) profile
 * @param {{ employeeId?: import('mongoose').Types.ObjectId|string, fromScheduler?: boolean }} [options]
 * Use `employeeId` when the caller knows which Employee row was updated — **owner is not unique** in this schema,
 * so `findOne({ owner })` can return the wrong row if duplicates exist (promotion then reads stale joiningDate).
 * Set `fromScheduler` so failed attempts log a **reason** (helps explain promoted=0).
 * @returns {Promise<boolean>} true if DB was updated
 */
export async function promoteCandidateOwnerToEmployeeRole(ownerUserId, options = {}) {
  const fromScheduler = Boolean(options.fromScheduler);

  if (!ownerUserId) return false;
  const { candidateRole, employeeRole } = await resolveCandidateAndEmployeeRoles();

  if (!employeeRole) {
    logger.warn('[employeeRolePromotion] Employee role not found — cannot promote from Candidate');
    return false;
  }

  let emp;
  const preferredId = options.employeeId != null ? String(options.employeeId) : '';
  if (preferredId) {
    emp = await Employee.findById(preferredId).select('joiningDate owner fullName email').lean();
    if (!emp?.owner) {
      if (fromScheduler) {
        logger.info(
          `[employeeRolePromotion] no-op user=${String(ownerUserId)} employeeDoc=${preferredId} reason=EMPLOYEE_MISSING_OWNER`
        );
      }
      return false;
    }
  } else {
    emp = await Employee.findOne({ owner: ownerUserId })
      .sort({ updatedAt: -1 })
      .select('joiningDate owner fullName email')
      .lean();
    if (!emp) return false;
  }

  /** Prefer login User matching profile email (owner may still be recruiter after public job apply). */
  const targetUserId = await resolveCandidateLoginUserIdForEmployee(emp, ownerUserId);
  if (emp.owner != null && String(emp.owner) !== String(targetUserId)) {
    await Employee.updateOne({ _id: emp._id }, { $set: { owner: targetUserId } });
    logger.info(
      `[employeeRolePromotion] aligned Employee.owner to candidate login ${targetUserId} (employee.email=${emp.email ?? ''})`
    );
    emp = { ...emp, owner: targetUserId };
  }

  const promoteUid = targetUserId;

  const noopInfo = (reason, detail = '') => {
    if (!fromScheduler) return;
    const empPart = options.employeeId != null ? ` employeeDoc=${String(options.employeeId)}` : '';
    logger.info(
      `[employeeRolePromotion] no-op user=${promoteUid}${empPart} reason=${reason}${detail ? ` ${detail}` : ''}`
    );
  };

  if (!emp?.joiningDate) {
    noopInfo('NO_JOINING_DATE_ON_EMPLOYEE_PROFILE');
    return false;
  }
  if (!joinCalendarDayHasArrived(emp.joiningDate)) {
    if (!fromScheduler) {
      logger.debug(
        `[employeeRolePromotion] Skipping promotion for user ${promoteUid} — joining date ${joinDateYmdUtc(emp.joiningDate)} not yet arrived`
      );
    }
    noopInfo(
      'JOINING_DAY_NOT_REACHED_UTC',
      `(stored=${joinDateYmdUtc(emp.joiningDate)} todayUtc=${joinDateYmdUtc(new Date())})`
    );
    return false;
  }

  const uid = String(promoteUid);
  const user = await User.findById(promoteUid).select('roleIds email name').lean();
  if (!user?.roleIds?.length) {
    noopInfo('USER_HAS_NO_ROLE_IDS');
    return false;
  }

  const candId = await resolveApplicantCandidateRoleIdForUser(user.roleIds, candidateRole);
  const hasCandidate = !!candId;

  const empRoleId = String(employeeRole._id);
  const hasEmployee = user.roleIds.some((id) => String(id) === empRoleId);

  // Already using Employee role; drop legacy Candidate if both are present.
  if (hasEmployee) {
    if (hasCandidate && candId) {
      await User.updateOne({ _id: promoteUid }, { $pull: { roleIds: candId } });
      const Student = (await import('../models/student.model.js')).default;
      await Student.updateMany({ user: promoteUid }, { $set: { joiningDate: emp.joiningDate } });
      logger.info(`[employeeRolePromotion] Removed duplicate Candidate role for user ${uid}`);
      return true;
    }
    noopInfo(
      'ALREADY_HAS_HR_EMPLOYEE_ROLE_NO_APPLICANT_CANDIDATE_ROLE',
      `(owner=${user.email ?? uid} candidateProfile=<${emp.email ?? '?'}>; User.roleIds already includes HR Employee role; no Role named Candidate to remove)`
    );
    return false;
  }

  if (!hasCandidate || !candId) {
    if (fromScheduler) {
      const debugDocs = await Role.find({ _id: { $in: user.roleIds } })
        .select('name status')
        .lean();
      const summary =
        debugDocs.length > 0
          ? debugDocs.map((r) => `"${String(r.name ?? '')}"(${String(r._id)})`).join('; ')
          : 'none';
      noopInfo(
        'NO_APPLICANT_CANDIDATE_ROLE_ON_USER',
        `(ownerLogin="${user.name ?? ''}" <${user.email ?? ''}> candidateEmployee="${emp.fullName ?? ''}" <${emp.email ?? ''}> ` +
          `roleIds=${(user.roleIds || []).map((id) => String(id)).join(',')} rolesMatched=${debugDocs.length}/${(user.roleIds || []).length} ${summary})`
      );
    }
    return false;
  }

  // MongoDB does not allow $pull and $addToSet on the same path in one operation.
  // Add Employee role first so the user is never left with zero roles.
  await User.updateOne(
    { _id: promoteUid },
    { $addToSet: { roleIds: employeeRole._id } }
  );
  await User.updateOne(
    { _id: promoteUid },
    { $pull: { roleIds: candId } }
  );
  const Student = (await import('../models/student.model.js')).default;
  await Student.updateMany({ user: promoteUid }, { $set: { joiningDate: emp.joiningDate } });
  logger.info(
    `[employeeRolePromotion] Candidate → Employee role for user ${uid} (joiningDate=${joinDateYmdUtc(emp.joiningDate)})`
  );
  return true;
}

/**
 * Batch (scheduler): promote Candidate → Employee only for accounts tied to **ATS Onboarding**
 * (`Placement.status === 'Joined'`), joining date calendar-eligible. Each row delegates to
 * {@link promoteCandidateOwnerToEmployeeRole} (resolves Candidate role id from the user’s Role documents).
 *
 * @returns {Promise<number>} number of users updated this run
 */
export async function promoteAllEligibleCandidateOwnersFromScheduler() {
  const { employeeRole } = await resolveCandidateAndEmployeeRoles();
  if (!employeeRole) {
    logger.warn('[scheduler] Candidate→Employee promotion skipped: Employee role missing (seed roles)');
    return 0;
  }

  /** Matches ATS Onboarding page: Joined placements only (Joined employees – HRMS). */
  const joinedCandidateRefs = await Placement.distinct('candidate', { status: 'Joined' });
  if (!joinedCandidateRefs.length) {
    logger.info('[scheduler] Candidate→Employee scan (Joined onboarding): no placements');
    return 0;
  }

  /** Same filter as list placements (`narrowPlacementQueryToValidCandidates`): hides stubs / deleted profiles. */
  const employeeDocsForJoined = await Employee.find({ _id: { $in: joinedCandidateRefs } })
    .select('_id fullName email')
    .lean();
  const onboardingEmployeeIds = employeeDocsForJoined.filter(placementCandidateHasDisplayIdentity).map((e) => e._id);

  const excludedFromUi = joinedCandidateRefs.length - onboardingEmployeeIds.length;
  if (!onboardingEmployeeIds.length) {
    logger.info(
      `[scheduler] Candidate→Employee scan (Joined onboarding): joinedDistinctCandidates=${joinedCandidateRefs.length} hrmsVisible=0 (none pass display-name/email filter)`
    );
    return 0;
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const endOfTodayUtc = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  const rows = await Employee.find({
    _id: { $in: onboardingEmployeeIds },
    owner: { $exists: true, $ne: null },
    joiningDate: { $exists: true, $ne: null, $lte: endOfTodayUtc },
  })
    .select('owner joiningDate')
    .lean();

  const eligibleByDate = rows.filter((row) => joinCalendarDayHasArrived(row.joiningDate));

  let updated = 0;
  let promotionAttempted = 0;

  for (const row of eligibleByDate) {
    promotionAttempted += 1;
    // eslint-disable-next-line no-await-in-loop
    const did = await promoteCandidateOwnerToEmployeeRole(row.owner, {
      employeeId: row._id,
      fromScheduler: true,
    });
    if (did) updated += 1;
  }

  logger.info(
    `[scheduler] Candidate→Employee scan (Joined onboarding): joinedDistinctCandidates=${joinedCandidateRefs.length} hrmsVisibleCandidates=${onboardingEmployeeIds.length}` +
      (excludedFromUi > 0 ? ` excludedFromHrmsList=${excludedFromUi}` : '') +
      ` mongoRows=${rows.length} calendarEligible=${eligibleByDate.length} promotionAttempts=${promotionAttempted} promoted=${updated}`
  );
  return updated;
}
