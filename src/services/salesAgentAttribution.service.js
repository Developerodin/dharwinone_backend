import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import ReferralAttributionDefault from '../models/referralAttribution.model.js';
import EmployeeDefault from '../models/employee.model.js';
import UserDefault from '../models/user.model.js';
import ActivityLogDefault from '../models/activityLog.model.js';
import JobApplicationDefault from '../models/jobApplication.model.js';
import ApiError from '../utils/ApiError.js';
import { SALES_AGENT_ROLE_NAME, userIsSalesAgent } from '../utils/roleHelpers.js';
import { withAttributionTransactionRetryOnce } from '../utils/withAttributionTransaction.js';
import { ATTRIBUTION_SOURCE, ACTIVITY_LOG_ACTION, ERROR_CODE } from '../constants/salesAgentAttribution.js';
import { deriveLifecycleStage, isActiveEmployee } from '../utils/lifecycleStage.js';

const ACTIVE = { isCurrent: true, isRevoked: false };

function throwError(statusCode, code, message) {
  throw new ApiError(statusCode, message, true, '', { errorCode: code });
}

/** Mirrors tenantResolver priority — tenantId may be unset or stale on legacy rows. */
export function resolveEffectiveTenantId(entity) {
  if (!entity) return '';
  if (entity.tenantId) return String(entity.tenantId);
  if (entity.adminId) return String(entity.adminId);
  if (entity._id) return String(entity._id);
  return '';
}

/** All ids that may denote the same org (handles stale tenantId vs correct adminId). */
export function collectTenantIdentityIds(entity) {
  const ids = [];
  if (entity?.tenantId) ids.push(String(entity.tenantId));
  if (entity?.adminId) ids.push(String(entity.adminId));
  if (entity?._id) ids.push(String(entity._id));
  return ids;
}

export function assertSharesTenantIdentity(leftIds, rightIds, subjectLabel = 'User') {
  const sharesTenant = leftIds.some((id) => rightIds.includes(id));
  if (!leftIds.length || !rightIds.length || !sharesTenant) {
    const messageByLabel = {
      Candidate: 'Employee is outside your organization.',
      Referrer: 'Referrer must belong to your organization.',
      'Sales agent': 'Sales agent must belong to your organization.',
    };
    const message =
      messageByLabel[subjectLabel] ||
      `${subjectLabel} must belong to the same tenant as the candidate.`;
    throwError(422, ERROR_CODE.CROSS_TENANT_ASSIGNMENT_FORBIDDEN, message);
  }
}

export async function currentSalesAgent(
  subjectProfileId,
  jobId,
  { Model = ReferralAttributionDefault, session = null } = {}
) {
  const sort = { assignedAt: -1, createdAt: -1 };
  if (jobId) {
    const exact = await Model.findOne({ subjectProfileId, jobId, ...ACTIVE }).sort(sort).session(session);
    if (exact) return exact;
  }
  const fallback = await Model.findOne({ subjectProfileId, jobId: null, ...ACTIVE }).sort(sort).session(session);
  return fallback;
}

export function assertSameTenant(candidate, otherUser, subjectLabel = 'Sales agent') {
  assertSharesTenantIdentity(
    collectTenantIdentityIds(candidate),
    collectTenantIdentityIds(otherUser),
    subjectLabel
  );
}

export function assertSalesAgentRole(user) {
  const roles = user?.roles || [];
  const hasRole = roles.some(
    (r) =>
      (typeof r === 'string' && r === SALES_AGENT_ROLE_NAME) ||
      (r && typeof r === 'object' && r.name === SALES_AGENT_ROLE_NAME)
  );
  if (!hasRole) {
    throwError(
      422,
      ERROR_CODE.SALES_AGENT_ROLE_REQUIRED,
      'Selected user does not have the sales_agent role.'
    );
  }
}

export async function assertSalesAgentRoleResolved(user) {
  if (user?.roles?.length) {
    try {
      assertSalesAgentRole(user);
      return;
    } catch {
      /* fall through to roleIds lookup */
    }
  }
  if (!(await userIsSalesAgent(user))) {
    throwError(
      422,
      ERROR_CODE.SALES_AGENT_ROLE_REQUIRED,
      'Selected user does not have the sales_agent role.'
    );
  }
}

export async function assertActorMayAssignResolved(actor) {
  assertActorMayAssign(actor);
  if (await userIsSalesAgent(actor)) {
    throwError(
      403,
      'SALES_AGENT_CANNOT_ASSIGN',
      'Users with the sales_agent role cannot manage attribution. Contact an Administrator or Agent.'
    );
  }
}

export function assertActorMayAssign(actor) {
  const roles = actor?.roles || [];
  const isSalesAgentActor = roles.some(
    (r) =>
      (typeof r === 'string' && r === SALES_AGENT_ROLE_NAME) ||
      (r && typeof r === 'object' && r.name === SALES_AGENT_ROLE_NAME)
  );
  if (isSalesAgentActor) {
    throwError(
      403,
      'SALES_AGENT_CANNOT_ASSIGN',
      'Users with the sales_agent role cannot manage attribution. Contact an Administrator or Agent.'
    );
  }
}

async function syncAttributionJobAnchor(Employee, employee, jobId, session) {
  if (jobId == null) return;
  if (String(employee.attributionJobId || '') === String(jobId)) return;
  await Employee.updateOne(
    { _id: employee._id },
    { $set: { attributionJobId: jobId } },
    session ? { session } : {}
  );
  employee.attributionJobId = jobId;
}

export async function recomputeEmployeeCache(employee, session, ctx = {}) {
  const Employee = ctx.Employee || EmployeeDefault;
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  let row = await currentSalesAgent(employee._id, employee.attributionJobId, {
    Model: ReferralAttribution,
    session,
  });
  if (!row) {
    row = await ReferralAttribution.findOne({ subjectProfileId: employee._id, ...ACTIVE })
      .sort({
        assignedAt: -1,
        createdAt: -1,
      })
      .session(session);
  }
  await Employee.updateOne(
    { _id: employee._id },
    {
      $set: {
        currentSalesAgentUserId: row ? row.salesAgentUserId : null,
        currentSalesAgentAssignedAt: row ? row.assignedAt : null,
        currentSalesAgentJobId: row ? row.jobId : null,
      },
    },
    session ? { session } : {}
  );
}

function buildSnapshot(user) {
  return {
    name: user.name || user.fullName || '',
    email: user.email || '',
    employeeCode: user.employeeId || null,
  };
}

async function buildJobSnapshot(jobId, ctx = {}) {
  const Job = ctx.Job || (await import('../models/job.model.js')).default;
  const job = await Job.findById(jobId).lean();
  if (!job) return null;
  return { title: job.title || '', requisitionCode: job.requisitionCode || null };
}

/**
 * When a referral is applied and the referrer holds the sales_agent role, also
 * record that referrer as the candidate's sales agent (referrer == sales agent),
 * regardless of whether the referral came via a job-share or onboarding link.
 * Scope follows the referral: job-scoped when the link carried a job, else
 * candidate-level. Idempotent (skips if a current attribution already exists) and
 * best-effort — it never throws into the registration / referral flow.
 *
 * @param {object} candidate - Employee mongoose doc (the referred candidate)
 * @param {import('mongoose').Types.ObjectId|string} referrerUserId
 * @param {import('mongoose').Types.ObjectId|string|null} [jobId] - referral job, if any
 * @param {object} [ctx] - dependency injection for tests
 * @returns {Promise<{auto:boolean, reason?:string, attributionId?:string}>}
 */
export async function autoAttributeReferrerAsSalesAgent(candidate, referrerUserId, jobId = null, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const User = ctx.User || UserDefault;
  const isSalesAgent = ctx.isSalesAgent || userIsSalesAgent;
  try {
    if (!candidate?._id || !referrerUserId) return { auto: false, reason: 'missing_input' };

    const referrer = await User.findById(referrerUserId);
    if (!referrer) return { auto: false, reason: 'referrer_not_found' };
    if (!(await isSalesAgent(referrer))) return { auto: false, reason: 'not_sales_agent' };

    const scopeJobId =
      jobId && mongoose.Types.ObjectId.isValid(String(jobId))
        ? new mongoose.Types.ObjectId(String(jobId))
        : null;

    // Idempotent: never stack a second current attribution for the same scope.
    const existing = await ReferralAttribution.findOne({
      subjectProfileId: candidate._id,
      jobId: scopeJobId,
      ...ACTIVE,
    });
    if (existing) return { auto: false, reason: 'attribution_exists' };

    const now = new Date();
    const [row] = await ReferralAttribution.create([
      {
        tenantId: resolveEffectiveTenantId(candidate) || candidate.tenantId,
        subjectProfileId: candidate._id,
        jobId: scopeJobId,
        salesAgentUserId: referrer._id,
        salesAgentSnapshot: buildSnapshot(referrer),
        jobSnapshot: scopeJobId ? await buildJobSnapshot(scopeJobId, ctx) : null,
        lifecycleStageAtAssignment: deriveLifecycleStage(candidate, { now }),
        attributionEventId: randomUUID(),
        assignedByUserId: referrer._id,
        assignedAt: now,
        notes: null,
        source: ATTRIBUTION_SOURCE.AUTO_REFERRAL_SALES_AGENT,
        isCurrent: true,
        isRevoked: false,
      },
    ]);

    if (scopeJobId) {
      await Employee.updateOne({ _id: candidate._id }, { $set: { attributionJobId: scopeJobId } });
      candidate.attributionJobId = scopeJobId;
    }
    // Non-transactional: the row above is committed, so this read (no session) sees it.
    await recomputeEmployeeCache(candidate, null, { Employee, ReferralAttribution });
    return { auto: true, attributionId: String(row._id) };
  } catch (e) {
    return { auto: false, reason: 'error', error: e?.message };
  }
}

async function assertCandidateLevelNotFrozen(Model, subjectProfileId, jobId) {
  if (jobId !== null && jobId !== undefined) return;
  const existing = await Model.countDocuments({
    subjectProfileId,
    jobId: { $ne: null },
    isCurrent: true,
    isRevoked: false,
  });
  if (existing > 0) {
    throwError(
      409,
      ERROR_CODE.CANDIDATE_LEVEL_FROZEN,
      'Job-specific attributions exist; candidate-level assignment is locked.'
    );
  }
}

async function writeActivityLog(ActivityLog, entry, session) {
  if (session) {
    await ActivityLog.create([entry], { session });
    return;
  }
  await ActivityLog.create(entry);
}

export async function assignSalesAgent(input, context, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const User = ctx.User || UserDefault;
  const ActivityLog = ctx.ActivityLog || ActivityLogDefault;
  const transaction = ctx.transaction || withAttributionTransactionRetryOnce;
  const { candidateId, salesAgentUserId, notes, assignedAt, jobId = null } = input;
  const actor = context.actor;

  const candidate = await Employee.findById(candidateId);
  if (!candidate) throwError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found.');
  const agent = await User.findById(salesAgentUserId);
  if (!agent) throwError(404, 'USER_NOT_FOUND', 'Sales agent user not found.');

  await assertSalesAgentRoleResolved(agent);
  await assertActorMayAssignResolved(actor);

  const resolvedAssignedAt = assignedAt ? new Date(assignedAt) : new Date();
  if (resolvedAssignedAt > new Date()) {
    throwError(422, ERROR_CODE.ASSIGN_DATE_IN_FUTURE, 'Assignment date cannot be in the future.');
  }

  await assertCandidateLevelNotFrozen(ReferralAttribution, candidate._id, jobId);

  const existing = await ReferralAttribution.findOne({
    subjectProfileId: candidate._id,
    jobId,
    isCurrent: true,
    isRevoked: false,
  });
  if (existing) {
    if (String(existing.salesAgentUserId) === String(salesAgentUserId)) {
      await syncAttributionJobAnchor(Employee, candidate, jobId, null);
      await recomputeEmployeeCache(candidate, null, { Employee, ReferralAttribution });
      return { attribution: existing };
    }
    throwError(
      409,
      'ATTRIBUTION_EXISTS_USE_PATCH',
      'A current attribution already exists for this candidate/job; use PATCH to change agent.'
    );
  }

  return transaction(async (session) => {
    const lifecycle = deriveLifecycleStage(candidate, { now: resolvedAssignedAt });
    const attributionEventId = randomUUID();
    const jobSnapshot = jobId ? await buildJobSnapshot(jobId, ctx) : null;
    const [row] = await ReferralAttribution.create(
      [
        {
          tenantId: resolveEffectiveTenantId(candidate) || candidate.tenantId,
          subjectProfileId: candidate._id,
          jobId,
          salesAgentUserId,
          salesAgentSnapshot: buildSnapshot(agent),
          jobSnapshot,
          lifecycleStageAtAssignment: lifecycle,
          attributionEventId,
          assignedByUserId: actor._id,
          assignedAt: resolvedAssignedAt,
          notes: notes || null,
          source: ATTRIBUTION_SOURCE.MANUAL_ASSIGN,
          isCurrent: true,
          isRevoked: false,
        },
      ],
      { session }
    );

    await syncAttributionJobAnchor(Employee, candidate, jobId, session);
    await recomputeEmployeeCache(candidate, session, { Employee, ReferralAttribution });

    await writeActivityLog(
      ActivityLog,
      {
        actor: actor._id,
        action: ACTIVITY_LOG_ACTION.ASSIGNED,
        entityType: 'Employee',
        entityId: String(candidate._id),
        metadata: {
          jobId,
          salesAgentUserId,
          attributionId: row._id,
          attributionEventId,
          notes: notes || null,
        },
      },
      session
    );

    return { attribution: row };
  });
}

export async function changeSalesAgent(input, context, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const User = ctx.User || UserDefault;
  const ActivityLog = ctx.ActivityLog || ActivityLogDefault;
  const transaction = ctx.transaction || withAttributionTransactionRetryOnce;
  const { candidateId, salesAgentUserId, expectedCurrentAttributionId, notes, assignedAt, jobId = null } = input;
  const actor = context.actor;

  const candidate = await Employee.findById(candidateId);
  if (!candidate) throwError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found.');
  const agent = await User.findById(salesAgentUserId);
  if (!agent) throwError(404, 'USER_NOT_FOUND', 'Sales agent user not found.');

  await assertSalesAgentRoleResolved(agent);
  await assertActorMayAssignResolved(actor);

  const resolvedAssignedAt = assignedAt ? new Date(assignedAt) : new Date();
  if (resolvedAssignedAt > new Date()) {
    throwError(422, ERROR_CODE.ASSIGN_DATE_IN_FUTURE, 'Assignment date cannot be in the future.');
  }

  const current = await ReferralAttribution.findOne({
    subjectProfileId: candidate._id,
    jobId,
    isCurrent: true,
    isRevoked: false,
  });
  if (!current) throwError(404, 'NO_CURRENT_ATTRIBUTION', 'No current attribution to change.');

  if (String(current._id) !== String(expectedCurrentAttributionId)) {
    throwError(
      409,
      ERROR_CODE.STALE_PRECONDITION,
      'Attribution changed by another admin. Reload and retry.'
    );
  }

  if (String(current.salesAgentUserId) === String(salesAgentUserId)) {
    await syncAttributionJobAnchor(Employee, candidate, jobId, null);
    await recomputeEmployeeCache(candidate, null, { Employee, ReferralAttribution });
    return { attribution: current, previousAttribution: null };
  }

  return transaction(async (session) => {
    const flipResult = await ReferralAttribution.updateOne(
      { _id: current._id, isCurrent: true, isRevoked: false },
      { $set: { isCurrent: false } },
      { session }
    );
    if (flipResult.matchedCount !== 1) {
      throwError(
        409,
        ERROR_CODE.STALE_PRECONDITION,
        'Attribution changed by another admin between read and write. Reload and retry.'
      );
    }

    const lifecycle = deriveLifecycleStage(candidate, { now: resolvedAssignedAt });
    const attributionEventId = randomUUID();
    const jobSnapshot = jobId ? await buildJobSnapshot(jobId, ctx) : null;
    const [row] = await ReferralAttribution.create(
      [
        {
          tenantId: resolveEffectiveTenantId(candidate) || candidate.tenantId,
          subjectProfileId: candidate._id,
          jobId,
          salesAgentUserId,
          salesAgentSnapshot: buildSnapshot(agent),
          jobSnapshot,
          lifecycleStageAtAssignment: lifecycle,
          attributionEventId,
          assignedByUserId: actor._id,
          assignedAt: resolvedAssignedAt,
          notes: notes || null,
          source: ATTRIBUTION_SOURCE.MANUAL_CHANGE,
          previousAttributionId: current._id,
          isCurrent: true,
          isRevoked: false,
        },
      ],
      { session }
    );

    await syncAttributionJobAnchor(Employee, candidate, jobId, session);
    await recomputeEmployeeCache(candidate, session, { Employee, ReferralAttribution });

    await writeActivityLog(
      ActivityLog,
      {
        actor: actor._id,
        action: ACTIVITY_LOG_ACTION.CHANGED,
        entityType: 'Employee',
        entityId: String(candidate._id),
        metadata: {
          jobId,
          previousSalesAgentUserId: current.salesAgentUserId,
          newSalesAgentUserId: salesAgentUserId,
          attributionId: row._id,
          attributionEventId,
          previousAttributionId: current._id,
          notes: notes || null,
        },
      },
      session
    );

    return { attribution: row, previousAttribution: current };
  });
}

export async function revokeSalesAgent(input, context, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const ActivityLog = ctx.ActivityLog || ActivityLogDefault;
  const transaction = ctx.transaction || withAttributionTransactionRetryOnce;
  const { candidateId, jobId = null, expectedCurrentAttributionId, revokeReason } = input;
  const actor = context.actor;

  if (!revokeReason || !String(revokeReason).trim()) {
    throwError(422, 'REVOKE_REASON_REQUIRED', 'Revoke reason is required.');
  }

  const candidate = await Employee.findById(candidateId);
  if (!candidate) throwError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found.');
  assertSameTenant(candidate, actor);
  assertActorMayAssign(actor);

  const current = await ReferralAttribution.findOne({
    subjectProfileId: candidate._id,
    jobId,
    isCurrent: true,
    isRevoked: false,
  });
  if (!current) throwError(404, 'NO_CURRENT_ATTRIBUTION', 'No current attribution to revoke.');
  if (String(current._id) !== String(expectedCurrentAttributionId)) {
    throwError(
      409,
      ERROR_CODE.STALE_PRECONDITION,
      'Attribution changed by another admin. Reload and retry.'
    );
  }

  return transaction(async (session) => {
    const attributionEventId = randomUUID();
    const revokeResult = await ReferralAttribution.updateOne(
      { _id: current._id, isCurrent: true, isRevoked: false },
      { $set: { isRevoked: true, revokedBy: actor._id, revokedAt: new Date(), revokeReason } },
      { session }
    );
    if (revokeResult.matchedCount !== 1) {
      throwError(
        409,
        ERROR_CODE.STALE_PRECONDITION,
        'Attribution changed by another admin between read and write. Reload and retry.'
      );
    }

    await recomputeEmployeeCache(candidate, session, { Employee, ReferralAttribution });

    await writeActivityLog(
      ActivityLog,
      {
        actor: actor._id,
        action: ACTIVITY_LOG_ACTION.REVOKED,
        entityType: 'Employee',
        entityId: String(candidate._id),
        metadata: {
          jobId,
          revokedSalesAgentUserId: current.salesAgentUserId,
          attributionId: current._id,
          attributionEventId,
          revokeReason,
        },
      },
      session
    );

    const plain = current.toObject ? current.toObject() : current;
    return { revokedAttribution: { ...plain, isRevoked: true } };
  });
}

function encodeCursor({ assignedAt, id }) {
  return Buffer.from(JSON.stringify({ a: assignedAt, i: String(id) })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export async function getSalesAgentHistory(candidateId, opts = {}, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const candidate = await Employee.findById(candidateId);
  if (!candidate) throwError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found.');

  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const cursor = decodeCursor(opts.cursor);

  const filter = { subjectProfileId: candidate._id };
  if (cursor) {
    filter.$or = [
      { assignedAt: { $lt: new Date(cursor.a) } },
      { assignedAt: new Date(cursor.a), _id: { $lt: new mongoose.Types.ObjectId(cursor.i) } },
    ];
  }

  const rows = await ReferralAttribution.find(filter)
    .sort({ assignedAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate('salesAgentUserId', 'name email')
    .populate('assignedByUserId', 'name email')
    .populate('jobId', 'title')
    .lean();

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore
    ? encodeCursor({ assignedAt: page[page.length - 1].assignedAt, id: page[page.length - 1]._id })
    : null;

  return {
    results: page.map((r) => ({
      id: String(r._id),
      jobId: r.jobId?._id ? String(r.jobId._id) : null,
      jobTitle: r.jobId?.title || null,
      salesAgent: r.salesAgentUserId
        ? {
            id: String(r.salesAgentUserId._id),
            name: r.salesAgentUserId.name,
            email: r.salesAgentUserId.email,
          }
        : null,
      salesAgentSnapshot: r.salesAgentSnapshot,
      lifecycleStageAtAssignment: r.lifecycleStageAtAssignment,
      assignedBy: r.assignedByUserId
        ? {
            id: String(r.assignedByUserId._id),
            name: r.assignedByUserId.name,
            email: r.assignedByUserId.email,
          }
        : null,
      assignedAt: r.assignedAt,
      notes: r.notes,
      source: r.source,
      isCurrent: r.isCurrent,
      isRevoked: r.isRevoked,
      revokeReason: r.revokeReason,
      previousAttributionId: r.previousAttributionId ? String(r.previousAttributionId) : null,
    })),
    nextCursor,
    hasMore,
  };
}

async function resolveBackfillOrgRoot(actor, employee, User) {
  const actorRoot = resolveEffectiveTenantId(actor);
  if (!actorRoot) return resolveEffectiveTenantId(employee) || null;
  if (!employee.adminId) return actorRoot;
  const adminRef = await User.findById(employee.adminId).select('_id').lean();
  if (!adminRef) return actorRoot;
  return resolveEffectiveTenantId(employee) || actorRoot;
}

export async function backfillReferralLead(input, context, ctx = {}) {
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const Employee = ctx.Employee || EmployeeDefault;
  const User = ctx.User || UserDefault;
  const ActivityLog = ctx.ActivityLog || ActivityLogDefault;
  const Job = ctx.Job || (await import('../models/job.model.js')).default;
  const transaction = ctx.transaction || withAttributionTransactionRetryOnce;
  const {
    employeeId,
    referredByUserId,
    salesAgentUserId,
    referralJobId = null,
    referredAt,
    notes,
  } = input;
  const actor = context.actor;

  if (!employeeId) throwError(422, ERROR_CODE.EMPLOYEE_NOT_FOUND, 'employeeId is required.');
  if (!referredByUserId) throwError(422, ERROR_CODE.REFERRER_NOT_FOUND, 'referredByUserId is required.');
  if (!salesAgentUserId) throwError(422, ERROR_CODE.SALES_AGENT_ROLE_REQUIRED, 'salesAgentUserId is required.');

  const employee = await Employee.findById(employeeId);
  if (!employee) throwError(404, ERROR_CODE.EMPLOYEE_NOT_FOUND, 'Employee not found.');
  if (employee.referredByUserId) {
    throwError(409, ERROR_CODE.ALREADY_REFERRED, 'Employee already has a referrer; use override flow instead.');
  }

  const referrer = await User.findById(referredByUserId);
  if (!referrer) throwError(404, ERROR_CODE.REFERRER_NOT_FOUND, 'Referrer user not found.');

  const employeeOwnerId = employee.owner ? String(employee.owner) : null;
  if (
    (employeeOwnerId && employeeOwnerId === String(referrer._id)) ||
    (employee.email && referrer.email && String(referrer.email).toLowerCase() === String(employee.email).toLowerCase())
  ) {
    throwError(422, ERROR_CODE.REFERRER_SELF_REFERENCE, 'Referrer cannot be the same person as the employee.');
  }

  await assertActorMayAssignResolved(actor);

  const agent = await User.findById(salesAgentUserId);
  if (!agent) throwError(404, 'USER_NOT_FOUND', 'Sales agent user not found.');
  await assertSalesAgentRoleResolved(agent);

  if (String(agent._id) === String(referrer._id)) {
    throwError(422, ERROR_CODE.REFERRER_SELF_REFERENCE, 'Sales agent and referrer must be different users.');
  }

  const resolvedReferredAt = referredAt ? new Date(referredAt) : new Date();
  if (resolvedReferredAt > new Date()) {
    throwError(422, ERROR_CODE.ASSIGN_DATE_IN_FUTURE, 'Referred date cannot be in the future.');
  }

  let job = null;
  let referralContext = 'SHARE_CANDIDATE_ONBOARD';
  if (referralJobId) {
    job = await Job.findById(referralJobId);
    if (!job) throwError(422, 'JOB_NOT_FOUND', 'Job not found.');
    referralContext = 'JOB_APPLY';
  }

  const orgRoot = await resolveBackfillOrgRoot(actor, employee, User);
  const orgOid =
    orgRoot && mongoose.Types.ObjectId.isValid(String(orgRoot))
      ? new mongoose.Types.ObjectId(String(orgRoot))
      : null;
  let repairedAdminId = null;
  if (orgOid) {
    if (!employee.adminId) {
      repairedAdminId = orgOid;
    } else {
      const adminRef = await User.findById(employee.adminId).select('_id').lean();
      if (!adminRef) repairedAdminId = orgOid;
    }
  }

  return transaction(async (session) => {
    const employeeUpdate = {
      referredByUserId: referrer._id,
      referralContext,
      referredAt: resolvedReferredAt,
      attributionLockedAt: resolvedReferredAt,
    };
    if (isActiveEmployee(employee, { now: resolvedReferredAt })) {
      employeeUpdate.referralPipelineStatus = 'hired';
    }
    if (repairedAdminId) employeeUpdate.adminId = repairedAdminId;
    if (orgOid && !employee.tenantId) employeeUpdate.tenantId = orgOid;
    if (job) {
      employeeUpdate.referralJobId = job._id;
      employeeUpdate.referralJobTitle = job.title || null;
    }
    await Employee.updateOne({ _id: employee._id }, { $set: employeeUpdate }, { session });
    Object.assign(employee, employeeUpdate);

    const lifecycle = deriveLifecycleStage(employee, { now: resolvedReferredAt });
    const attributionEventId = randomUUID();
    const jobSnapshot = job ? { title: job.title || '', requisitionCode: job.requisitionCode || null } : null;

    const [row] = await ReferralAttribution.create(
      [
        {
          tenantId: orgOid || resolveEffectiveTenantId(actor) || resolveEffectiveTenantId(employee) || employee.tenantId,
          subjectProfileId: employee._id,
          jobId: job ? job._id : null,
          salesAgentUserId: agent._id,
          salesAgentSnapshot: buildSnapshot(agent),
          jobSnapshot,
          lifecycleStageAtAssignment: lifecycle,
          attributionEventId,
          assignedByUserId: actor._id,
          assignedAt: resolvedReferredAt,
          notes: notes || null,
          source: ATTRIBUTION_SOURCE.MANUAL_ASSIGN,
          isCurrent: true,
          isRevoked: false,
        },
      ],
      { session }
    );

    if (job) {
      await Employee.updateOne({ _id: employee._id }, { $set: { attributionJobId: job._id } }, { session });
      employee.attributionJobId = job._id;
    }

    await recomputeEmployeeCache(employee, session, { Employee, ReferralAttribution });

    await writeActivityLog(
      ActivityLog,
      {
        actor: actor._id,
        action: ACTIVITY_LOG_ACTION.MANUAL_BACKFILLED,
        entityType: 'Employee',
        entityId: String(employee._id),
        metadata: {
          referredByUserId: String(referrer._id),
          salesAgentUserId: String(agent._id),
          referralJobId: job ? String(job._id) : null,
          referredAt: resolvedReferredAt,
          attributionId: String(row._id),
          attributionEventId,
          notes: notes || null,
        },
      },
      session
    );

    return { attribution: row, employeeId: String(employee._id) };
  });
}

export async function pinAttributionJob(input, context, ctx = {}) {
  const Employee = ctx.Employee || EmployeeDefault;
  const Job = ctx.Job || (await import('../models/job.model.js')).default;
  const JobApplication = ctx.JobApplication || JobApplicationDefault;
  const ActivityLog = ctx.ActivityLog || ActivityLogDefault;
  const ReferralAttribution = ctx.ReferralAttribution || ReferralAttributionDefault;
  const { candidateId, jobId, reason } = input;
  const actor = context.actor;
  const candidate = await Employee.findById(candidateId);
  if (!candidate) throwError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found.');
  assertSameTenant(candidate, actor);
  assertActorMayAssign(actor);

  if (jobId != null) {
    if (!reason || !String(reason).trim()) {
      throwError(422, 'REASON_REQUIRED', 'Reason is required when pinning a job.');
    }
    const job = await Job.findById(jobId);
    if (!job) throwError(422, 'JOB_NOT_FOUND', 'Job not found.');
    const hasApp = await JobApplication.exists({ candidate: candidate._id, job: jobId });
    if (!hasApp) throwError(422, 'NO_APPLICATION_FOR_JOB', 'Candidate has no application for this job.');
  }

  await Employee.updateOne({ _id: candidate._id }, { $set: { attributionJobId: jobId } });
  candidate.attributionJobId = jobId;
  await recomputeEmployeeCache(candidate, null, { Employee, ReferralAttribution });

  await writeActivityLog(ActivityLog, {
    actor: actor._id,
    action:
      jobId == null
        ? ACTIVITY_LOG_ACTION.ATTRIBUTION_JOB_UNPINNED
        : ACTIVITY_LOG_ACTION.ATTRIBUTION_JOB_PINNED,
    entityType: 'Employee',
    entityId: String(candidate._id),
    metadata: { jobId, reason: reason || null },
  });

  return { employee: await Employee.findById(candidate._id) };
}
