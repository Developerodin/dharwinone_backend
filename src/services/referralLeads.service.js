import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import ActivityLog from '../models/activityLog.model.js';
import Job from '../models/job.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Offer from '../models/offer.model.js';
import Placement from '../models/placement.model.js';
import Meeting from '../models/meeting.model.js';
import config from '../config/config.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import * as activityLogService from './activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { logReferralEvent } from './referralAttribution.service.js';
import logger from '../config/logger.js';
import { userIsSalesAgent, userIsAdmin, userIsAgent } from '../utils/roleHelpers.js';
import {
  CONVERTED_PIPELINE_STATUSES,
  PENDING_PIPELINE_STATUSES,
  applyLifecycleOverlay,
  rankSalesAgentHires,
  deriveReferralPipelineStatus,
  isTerminalMetaStatus,
  pipelineStatusToLifecycleStage,
} from '../utils/referralPipelineStatus.js';
import {
  applyNewFilters,
  buildSalesAgentListEnrichmentStages,
} from './referralLeadsQueryBuilder.js';
import ReferralAttribution from '../models/referralAttribution.model.js';
import { getOwnerIdsWithApplicantCandidateRoleOnly } from './role.service.js';

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const APP_STAGE_RANK = {
  Hired: 6,
  Offered: 5,
  Interview: 4,
  Screening: 3,
  Applied: 2,
  Rejected: 1,
};

const isProfileCompleteLean = (candidate) =>
  Boolean(candidate?.isCompleted || candidate?.isProfileCompleted === 100);

const ATTRIBUTION_ANCHOR_STATUSES = new Set(['preboarding', 'hired', 'joined', 'employee']);

/**
 * Prefer the furthest-along application for denormalised job column (tie-break: most recently updated).
 */
const pickPrimaryApplication = (apps) => {
  if (!apps?.length) return null;
  return [...apps].sort((a, b) => {
    const ra = APP_STAGE_RANK[a.status] ?? 0;
    const rb = APP_STAGE_RANK[b.status] ?? 0;
    if (rb !== ra) return rb - ra;
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  })[0];
};

/**
 * Single source of truth for `referralPipelineStatus` / denormalised job fields on referred candidates.
 *
 * - With pipeline data: derives unified status from applications, interviews, offers, placements.
 * - With none: pending/profile_complete while idle; withdrawn after last application deleted; preserves job_removed / withdrawn unless applications appear again.
 *
 * @param {import('mongoose').Types.ObjectId|string} candidateId
 * @param {object} [options]
 * @param {boolean} [options.fromApplicationDeletion] - Last JobApplication row was removed (withdraw / admin delete).
 * @param {import('mongoose').Types.ObjectId|string|null} [options.withdrawalJobId] - Job ref from deleted application (also accepts withdrawnJobId).
 */
export async function syncReferralPipelineStatusForCandidate(candidateId, options = {}) {
  const withdrawalJobId = options.withdrawalJobId ?? options.withdrawnJobId ?? null;
  const fromApplicationDeletion =
    options.fromApplicationDeletion === true || options.fromApplicationWithdrawal === true;

  const cid =
    candidateId != null && typeof candidateId.toString === 'function'
      ? candidateId.toString()
      : String(candidateId || '');
  if (!mongoose.Types.ObjectId.isValid(cid)) return;

  const c = await Employee.findById(cid)
    .select(
      'referredByUserId referralPipelineStatus referralJobId referralJobTitle referralContext isCompleted isProfileCompleted attributionJobId joiningDate isActive'
    )
    .lean();

  if (!c?.referredByUserId) return;

  const current = c.referralPipelineStatus || 'pending';

  const [apps, placements, offers, meetings] = await Promise.all([
    JobApplication.find({ candidate: cid })
      .sort({ updatedAt: -1 })
      .select('job status updatedAt createdAt')
      .lean(),
    Placement.find({ candidate: cid }).select('status job updatedAt').lean(),
    Offer.find({ candidate: cid }).select('status updatedAt').lean(),
    Meeting.find({ 'candidate.id': cid }).select('status interviewResult updatedAt').lean(),
  ]);

  if (!apps.length && !placements.length && !offers.length) {
    if (fromApplicationDeletion) {
      let jobOid = null;
      let title = null;
      if (withdrawalJobId && mongoose.Types.ObjectId.isValid(String(withdrawalJobId))) {
        jobOid =
          withdrawalJobId instanceof mongoose.Types.ObjectId
            ? withdrawalJobId
            : new mongoose.Types.ObjectId(String(withdrawalJobId));
        const job = await Job.findById(jobOid).select('title').lean();
        title = job?.title || null;
      }
      await Employee.updateOne(
        { _id: cid },
        {
          $set: {
            referralPipelineStatus: 'withdrawn',
            referralJobId: jobOid,
            referralJobTitle: title,
          },
        }
      );
      return;
    }

    const derivedIdle = deriveReferralPipelineStatus({ employee: c, apps, placements, offers, meetings });

    /** A passed joiningDate means they actually joined — overrides terminal/job-deletion meta even
     * with no surviving ATS rows (job/application can be deleted post-hire). */
    if (derivedIdle === 'employee' || derivedIdle === 'resigned') {
      if (derivedIdle !== current) {
        await Employee.updateOne({ _id: cid }, { $set: { referralPipelineStatus: derivedIdle } });
      }
      return;
    }

    /** Idle: no pipeline rows — do not clobber terminal/job-deletion rows unless profile catches up. */
    if (isTerminalMetaStatus(current)) {
      if (isProfileCompleteLean(c) && current !== 'profile_complete') {
        await Employee.updateOne({ _id: cid }, { $set: { referralPipelineStatus: 'profile_complete' } });
      }
      return;
    }

    if (derivedIdle) {
      await Employee.updateOne({ _id: cid }, { $set: { referralPipelineStatus: derivedIdle } });
      return;
    }

    const nextStatus = isProfileCompleteLean(c) ? 'profile_complete' : 'pending';
    if (nextStatus === current) return;

    await Employee.updateOne({ _id: cid }, { $set: { referralPipelineStatus: nextStatus } });
    return;
  }

  /** Active pipeline — derive from ATS sources (clears withdrawn/job_removed semantics). */
  const nextPipeline =
    deriveReferralPipelineStatus({ employee: c, apps, placements, offers, meetings }) || 'applied';
  const primary = pickPrimaryApplication(apps);
  const primaryPlacement = placements?.length
    ? [...placements].sort(
        (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
      )[0]
    : null;
  const jobOid = primary?.job || primaryPlacement?.job || null;
  let title = null;
  if (jobOid) {
    const job = await Job.findById(jobOid).select('title').lean();
    title = job?.title || null;
  }

  const willAnchorAttribution =
    ATTRIBUTION_ANCHOR_STATUSES.has(nextPipeline) && !ATTRIBUTION_ANCHOR_STATUSES.has(current);
  const $set = {
    referralPipelineStatus: nextPipeline,
    referralJobId: jobOid,
    referralJobTitle: title,
  };
  if (willAnchorAttribution && jobOid && !c.attributionJobId) {
    $set.attributionJobId = jobOid;
  }
  await Employee.updateOne({ _id: cid }, { $set });
}

/**
 * Who may see the full org referral-lead list (else scoped to their own `referredByUserId`).
 * - `candidates.manage`: ATS admins
 * - `interviews.manage`: same org-wide need as the Schedule Interview jobs/recruiters pick lists
 * @param {import('express').Request} req
 */
/**
 * Same access as referral lead list row: org-wide readers, or current lead referrer.
 * @param {import('express').Request} req
 * @param {string} candidateId
 */
export const assertReferralLeadViewAccess = async (req, candidateId) => {
  const c = await Employee.findById(candidateId).select('referredByUserId').lean();
  if (!c) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (await canUserSeeAllReferralLeads(req)) {
    return;
  }
  if (c.referredByUserId && String(c.referredByUserId) === String(req.user._id)) {
    return;
  }
  throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
};

/**
 * Audit trail of admin attribution overrides for a lead (from ActivityLog).
 * @param {import('express').Request} req
 */
export const getReferralAttributionOverrideHistory = async (req) => {
  const { candidateId } = req.params;
  await assertReferralLeadViewAccess(req, candidateId);
  const rows = await ActivityLog.find({
    action: ActivityActions.REFERRAL_ATTRIBUTION_OVERRIDE,
    entityType: EntityTypes.CANDIDATE,
    entityId: String(candidateId),
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate({ path: 'actor', select: 'name email' })
    .lean();

  const idSet = new Set();
  for (const r of rows) {
    const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    if (m.previousReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.previousReferredByUserId))) {
      idSet.add(String(m.previousReferredByUserId));
    }
    if (m.newReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.newReferredByUserId))) {
      idSet.add(String(m.newReferredByUserId));
    }
  }
  const ids = [...idSet];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name email').lean() : [];
  const uMap = new Map(
    users.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email }])
  );

  const shapeActor = (r) => {
    const a = r.actor;
    if (a && typeof a === 'object' && (a.name !== undefined || a.email !== undefined)) {
      return {
        id: (a._id || a.id).toString(),
        name: a.name,
        email: a.email,
      };
    }
    return { id: String(r.actor), name: 'Unknown', email: undefined };
  };

  return {
    results: rows.map((r) => {
      const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
      const prevId =
        m.previousReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.previousReferredByUserId))
          ? String(m.previousReferredByUserId)
          : null;
      const newId =
        m.newReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.newReferredByUserId))
          ? String(m.newReferredByUserId)
          : null;
      return {
        id: r._id.toString(),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        actor: shapeActor(r),
        previousReferredBy: prevId ? uMap.get(prevId) || { id: prevId, name: 'Unknown', email: undefined } : null,
        newReferredBy: newId ? uMap.get(newId) || { id: newId, name: 'Unknown', email: undefined } : null,
        reason: m.reason != null ? String(m.reason) : '',
      };
    }),
  };
};

export const canSeeAllReferralLeads = (req) => {
  const p = req.authContext?.permissions;
  if (!p) return false;
  if (p.has('candidates.manage')) return true;
  if (p.has('interviews.manage')) return true;
  return false;
};

/**
 * Org-wide referral lead list (else match is forced to `referredByUserId: req.user`).
 * Sales agents are always scoped to their own referrals — never `interviews.manage` / `candidates.manage` bypass.
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
export const canUserSeeAllReferralLeads = async (req) => {
  if (await userIsSalesAgent(req.user)) return false;
  return canSeeAllReferralLeads(req);
};

/**
 * Build Mongo match for referral leads (referred candidates; not restricted by Candidate-role owner roster).
 * @param {object} opts
 * @param {object} opts.user
 * @param {boolean} opts.canSeeAll
 * @param {object} opts.query - parsed query string
 */
export const buildReferralLeadsMatch = async (opts) => {
  const { user, canSeeAll, query } = opts;
  const mongo = {
    referredByUserId: { $exists: true, $ne: null },
  };

  if (!canSeeAll) {
    // Scoped view: surface referral leads you referred OR ones you're the assigned sales
    // agent for. Mirrors how a referrer sees their own candidates — the assigned sales
    // agent (Employee.currentSalesAgentUserId, kept in sync by salesAgentAttribution) now
    // sees the same candidate too.
    mongo.$and = (mongo.$and || []).concat([
      {
        $or: [{ referredByUserId: user._id }, { currentSalesAgentUserId: user._id }],
      },
    ]);
  } else if (query.referredByUserId && mongoose.Types.ObjectId.isValid(String(query.referredByUserId))) {
    mongo.referredByUserId = new mongoose.Types.ObjectId(String(query.referredByUserId));
  }

  if (query.referralContext && ['SHARE_CANDIDATE_ONBOARD', 'JOB_APPLY'].includes(query.referralContext)) {
    mongo.referralContext = query.referralContext;
  }

  // NOTE: status is NOT filtered here. The column badge shows an EFFECTIVE status (joined→
  // employee/resigned, deleted job→job_removed, in_review→interview) computed in shapeLeadRow, which
  // diverges from the raw stored field. Status filtering happens downstream on the computed
  // `effectiveStatus` field — see buildEffectiveStatusStages + effectiveStatusMatch.

  if (query.from || query.to) {
    mongo.referredAt = {};
    if (query.from) {
      mongo.referredAt.$gte = new Date(query.from);
    }
    if (query.to) {
      const t = new Date(query.to);
      t.setHours(23, 59, 59, 999);
      mongo.referredAt.$lte = t;
    }
  }

  if (query.search && String(query.search).trim()) {
    const q = escapeRegex(String(query.search).trim());
    mongo.$and = (mongo.$and || []).concat([
      {
        $or: [
          { fullName: { $regex: q, $options: 'i' } },
          { email: { $regex: q, $options: 'i' } },
        ],
      },
    ]);
  }

  // Default: do not filter by `owner` role. Referred signups from share-onboarding and
  // public/invite often have Student-only or no `roleIds` until activation; they still
  // have a Candidate document and must appear on the referral-leads page.
  // Interview scheduling opts in via `candidateRoleOwnersOnly` to exclude promoted employees.
  if (query.candidateRoleOwnersOnly) {
    const ownerIds = await getOwnerIdsWithApplicantCandidateRoleOnly();
    mongo.owner = { $in: ownerIds ?? [] };
  }

  return mongo;
};

/**
 * Org-wide match for the "top referrer" card only.
 * Ignores self-scope (sales agent), referrer dropdown, pipeline status, and search — otherwise a scoped
 * view would always rank the current user #1 with their own count.
 * Still respects **Link type** and **date range** so the leaderboard matches the reporting window.
 *
 * @param {object} query - parsed query string (same shape as referral leads list)
 */
const buildGlobalTopReferrerMatch = (query) => {
  const mongo = {
    referredByUserId: { $exists: true, $ne: null },
  };

  if (query.referralContext && ['SHARE_CANDIDATE_ONBOARD', 'JOB_APPLY'].includes(query.referralContext)) {
    mongo.referralContext = query.referralContext;
  }

  if (query.from || query.to) {
    mongo.referredAt = {};
    if (query.from) {
      mongo.referredAt.$gte = new Date(query.from);
    }
    if (query.to) {
      const t = new Date(query.to);
      t.setHours(23, 59, 59, 999);
      mongo.referredAt.$lte = t;
    }
  }

  return mongo;
};

/**
 * After a job application is deleted (candidate withdraw or admin): delegates to {@link syncReferralPipelineStatusForCandidate}.
 *
 * @param {import('mongoose').Types.ObjectId|string} candidateId
 * @param {object} [options]
 * @param {import('mongoose').Types.ObjectId|string|null} [options.withdrawnJobId] - job from the deleted application (for JOB column + context)
 */
export const syncReferralPipelineAfterApplicationWithdrawal = async (candidateId, options = {}) => {
  if (!candidateId) return;
  await syncReferralPipelineStatusForCandidate(candidateId, {
    fromApplicationDeletion: true,
    withdrawalJobId: options.withdrawnJobId ?? options.withdrawalJobId ?? null,
  });
};

/**
 * Normalize a user ref (ObjectId, subdoc, string, populated lean doc) to a 24-hex id string.
 * Dot-notation `populate` on `referralLastOverride.*` is unreliable for single nested subdocs, so we resolve by id.
 * @param {unknown} v
 * @returns {string|null}
 */
const asObjectIdString = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v._id != null) return String(v._id);
    if (v.id != null && mongoose.isValidObjectId(v.id)) return String(v.id);
  }
  if (typeof v === 'string' && mongoose.isValidObjectId(v)) return v;
  try {
    if (typeof v?.toString === 'function' && (v._bsontype === 'ObjectID' || v.constructor?.name === 'ObjectId')) {
      const s = v.toString();
      if (s && mongoose.isValidObjectId(s)) return s;
    }
  } catch {
    // ignore
  }
  try {
    const s = v.toString?.();
    if (s && mongoose.isValidObjectId(s)) return s;
  } catch {
    // ignore
  }
  return null;
};

/**
 * @param {object|null|undefined} rlo
 * @returns {Promise<object|null>}
 */
const shapeReferralLastOverride = async (rlo) => {
  if (!rlo) return null;
  if (
    !rlo.overriddenAt &&
    !rlo.overriddenBy &&
    !rlo.previousReferredByUserId &&
    !rlo.newReferredByUserId
  ) {
    return null;
  }
  const idBy = asObjectIdString(rlo.overriddenBy);
  const idPrev = asObjectIdString(rlo.previousReferredByUserId);
  const idNew = asObjectIdString(rlo.newReferredByUserId);
  const unique = [...new Set([idBy, idPrev, idNew].filter(Boolean))];
  const users = unique.length
    ? await User.find({ _id: { $in: unique } })
        .select('name email')
        .lean()
    : [];
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const toSummary = (idStr) => {
    if (!idStr) return null;
    const u = byId.get(idStr);
    if (u) return { id: u._id.toString(), name: u.name, email: u.email };
    return { id: idStr, name: 'Unknown', email: undefined };
  };
  return {
    reason: rlo.reason != null ? String(rlo.reason) : '',
    overriddenAt: rlo.overriddenAt ? new Date(rlo.overriddenAt).toISOString() : null,
    overriddenByUser: toSummary(idBy),
    previousReferredBy: toSummary(idPrev),
    newReferredBy: toSummary(idNew),
  };
};

/**
 * @param {import('mongoose').Document|object} row
 * @param {object} [options]
 * @param {Set<string>} [options.appliedJobApplyOrphans] - from {@link appliedJobPostingOrphansForJobApplyApplied}
 */
const shapeLeadRow = async (row, options = {}) => {
  const o = row.toObject ? row.toObject() : { ...row };
  const ref = o.referredByUserId;
  let referredBy = null;
  if (ref && typeof ref === 'object' && (ref.name || ref.email)) {
    referredBy = { id: (ref._id || ref.id).toString(), name: ref.name, email: ref.email };
  } else if (ref) {
    const u = await User.findById(ref).select('name email').lean();
    if (u) referredBy = { id: u._id.toString(), name: u.name, email: u.email };
  }
  /** Aggregates set `referralJobMissing` when `referralJobId` pointed at a deleted Job. */
  const jobMissing = o.referralJobMissing === true;
  let job = null;
  let effectivePipelineStatus = o.referralPipelineStatus || 'pending';

  const cidStr = o._id?.toString?.() || (o.id != null ? String(o.id) : '');
  if (
    cidStr &&
    options.appliedJobApplyOrphans?.has?.(cidStr) &&
    o.referralContext === 'JOB_APPLY' &&
    String(effectivePipelineStatus) === 'applied'
  ) {
    job = null;
    if (!['withdrawn', 'rejected'].includes(String(effectivePipelineStatus))) {
      effectivePipelineStatus = 'job_removed';
    }
  } else if (jobMissing) {
    job = null;
    if (
      effectivePipelineStatus &&
      !['withdrawn', 'rejected'].includes(String(effectivePipelineStatus)) &&
      effectivePipelineStatus !== 'job_removed'
    ) {
      effectivePipelineStatus = 'job_removed';
    }
  } else if (o.referralJobId && typeof o.referralJobId === 'object' && o.referralJobId.title) {
    job = {
      id: (o.referralJobId._id || o.referralJobId.id).toString(),
      title: o.referralJobId.title,
    };
  } else if (o.referralJobId) {
    const jobOidForLookup = asObjectIdString(o.referralJobId);
    const j = jobOidForLookup ? await Job.findById(jobOidForLookup).select('title').lean() : null;
    if (j) job = { id: jobOidForLookup, title: j.title };
    else if (jobOidForLookup) {
      /** Stale referralJobId pointing at deleted/missing Job (cleanup may not have run). */
      job = null;
      if (
        !['withdrawn', 'rejected'].includes(String(effectivePipelineStatus)) &&
        effectivePipelineStatus !== 'job_removed'
      ) {
        effectivePipelineStatus = 'job_removed';
      }
    } else if (o.referralJobTitle) {
      job = { title: o.referralJobTitle };
    }
  } else if (o.referralJobTitle) {
    job = { title: o.referralJobTitle };
  }

  // Post-join lifecycle (employee/resigned) is time-driven — recompute on read so a passed
  // joiningDate / resignation surfaces even if no ATS event re-synced the stored status. Gated on
  // the ORIGINAL stored status (not the job_removed-mutated value): a candidate who joined is an
  // employee even if their referral job was later deleted, so this wins over job_removed.
  // lifecycleStage stays a legacy mirror for API consumers.
  const lifecycleOverride = applyLifecycleOverlay(o.referralPipelineStatus, o, new Date());
  if (lifecycleOverride === 'employee' || lifecycleOverride === 'resigned') {
    effectivePipelineStatus = lifecycleOverride;
  } else if (effectivePipelineStatus === 'in_review') {
    effectivePipelineStatus = 'interview';
  }

  const referralLastOverride = await shapeReferralLastOverride(o.referralLastOverride);

  if (o.profilePicture?.key) {
    try {
      o.profilePicture.url = await generatePresignedDownloadUrl(o.profilePicture.key, 7 * 24 * 3600);
    } catch (e) {
      logger.warn('referralLeads presign profile:', e?.message);
    }
  }
  return {
    id: o._id?.toString?.() || o.id,
    fullName: o.fullName,
    email: o.email,
    profilePicture: o.profilePicture,
    referredBy,
    referralContext: o.referralContext,
    referredAt: o.referredAt,
    attributionLockedAt: o.attributionLockedAt,
    referralAttributionAnonymised: o.referralAttributionAnonymised,
    referralPipelineStatus: effectivePipelineStatus,
    referralBatchId: o.referralBatchId,
    job,
    referralLastOverride,
    createdAt: o.createdAt,
    salesAgent: o.currentSalesAgent
      ? {
          id: String(o.currentSalesAgent._id || o.currentSalesAgent.id),
          name: o.currentSalesAgent.name || o.currentSalesAgent.fullName,
          email: o.currentSalesAgent.email,
        }
      : null,
    salesAgentAssignedAt: o.currentSalesAgentAssignedAt || null,
    salesAgentJobScope: o.currentSalesAgentJobId == null ? 'candidate' : 'job',
    salesAgentCurrentAttributionId: o.currentSalesAgentAttributionId
      ? String(o.currentSalesAgentAttributionId)
      : null,
    lifecycleStage: o.lifecycleStage || pipelineStatusToLifecycleStage(effectivePipelineStatus),
    employeeConverted: o.employeeConverted === true,
    employeeStatus: o.employeeStatus || null,
    joiningDate: o.joiningDate || null,
    resignDate: o.resignDate || null,
  };
};

const usersCollectionName = () => User.collection.collectionName;
const jobsCollectionName = () => Job.collection.collectionName;
/**
 * JOB_APPLY + applied rows whose latest application points at a deleted job (or no application row).
 * Fixes legacy rows where Employee still has denormalised title/referralJobId drift.
 *
 * @param {object[]} rows - aggregate rows before shapeLeadRow
 * @returns {Promise<Set<string>>} candidate ids to show as job_removed
 */
async function appliedJobPostingOrphansForJobApplyApplied(rows) {
  const candIds = rows
    .filter(
      (r) =>
        String(r.referralPipelineStatus) === 'applied' &&
        r.referralContext === 'JOB_APPLY' &&
        r.referralJobMissing !== true
    )
    .map((r) => r._id);
  if (!candIds.length) return new Set();

  const jobsColl = jobsCollectionName();

  const agg = await JobApplication.aggregate([
    { $match: { candidate: { $in: candIds } } },
    { $sort: { updatedAt: -1 } },
    { $group: { _id: '$candidate', jobId: { $first: '$job' } } },
    {
      $lookup: {
        from: jobsColl,
        localField: 'jobId',
        foreignField: '_id',
        as: 'jobHits',
      },
    },
  ]);

  const hasHealthyJobPosting = new Map();
  for (const x of agg) {
    hasHealthyJobPosting.set(String(x._id), Array.isArray(x.jobHits) && x.jobHits.length > 0);
  }

  const orphans = new Set();
  for (const cid of candIds) {
    const s = String(cid);
    if (!hasHealthyJobPosting.has(s) || !hasHealthyJobPosting.get(s)) {
      orphans.add(s);
    }
  }
  return orphans;
}

/**
 * Referral rows are Candidate (`Employee`) documents with denormalized name/email.
 * They always have `owner` → portal User. After user hard-delete, cascade should remove the candidate;
 * if anything is missed (legacy data, partial failure), the owner id can point at a deleted user.
 * These stages restrict lists/stats/export to candidates whose owner still exists in `users`.
 */
const referralLeadsRequireExistingOwnerStages = () => {
  const from = usersCollectionName();
  return [
    {
      $lookup: {
        from,
        localField: 'owner',
        foreignField: '_id',
        as: '__portalOwnerExists',
      },
    },
    { $match: { '__portalOwnerExists.0': { $exists: true } } },
    { $project: { __portalOwnerExists: 0 } },
  ];
};

/** Match shapeLeadRow: single embedded docs for referrer + job (like .populate().lean()). */
const referralLeadsPopulateReferrerAndJobStages = () => {
  const usersColl = usersCollectionName();
  const jobsColl = jobsCollectionName();
  return [
    { $set: { _referralJobOid: '$referralJobId' } },
    {
      $lookup: {
        from: usersColl,
        localField: 'referredByUserId',
        foreignField: '_id',
        as: 'referredByUserIdArr',
      },
    },
    {
      $addFields: {
        referredByUserId: { $arrayElemAt: ['$referredByUserIdArr', 0] },
      },
    },
    { $project: { referredByUserIdArr: 0 } },
    {
      $lookup: {
        from: jobsColl,
        localField: '_referralJobOid',
        foreignField: '_id',
        as: 'referralJobIdArr',
      },
    },
    {
      $addFields: {
        referralJobId: { $arrayElemAt: ['$referralJobIdArr', 0] },
        referralJobMissing: {
          $and: [{ $ne: ['$_referralJobOid', null] }, { $eq: [{ $size: '$referralJobIdArr' }, 0] }],
        },
      },
    },
    { $project: { referralJobIdArr: 0, _referralJobOid: 0 } },
  ];
};

/** Stored statuses that are NOT reinterpreted as job_removed when the job is gone (terminal already). */
const JOB_REMOVED_EXEMPT = ['withdrawn', 'rejected', 'job_removed'];

/**
 * Aggregation stages that compute `effectiveStatus` — the SAME status the column badge shows
 * (see shapeLeadRow), so the list/count/cards/export can FILTER and BUCKET by what the user sees
 * instead of the raw stored field. Precedence mirrors shapeLeadRow exactly:
 *   joined (joiningDate ≤ now) → employee/resigned  >  job gone → job_removed  >  in_review → interview  >  stored.
 * "Job gone" = the referral's job was deleted (referralJobId dangling) OR an applied/JOB_APPLY lead
 * whose latest application points at a deleted job (mirrors appliedJobPostingOrphansForJobApplyApplied).
 * MUST run BEFORE referralLeadsPopulateReferrerAndJobStages (which replaces referralJobId with a doc).
 *
 * @param {Date} now
 */
export const buildEffectiveStatusStages = (now) => {
  const jobsColl = jobsCollectionName();
  const appsColl = JobApplication.collection.collectionName;
  return [
    { $lookup: { from: jobsColl, localField: 'referralJobId', foreignField: '_id', as: '_effRefJobHits' } },
    {
      $lookup: {
        from: appsColl,
        let: { cand: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$candidate', '$$cand'] } } },
          { $sort: { updatedAt: -1 } },
          { $limit: 1 },
          { $lookup: { from: jobsColl, localField: 'job', foreignField: '_id', as: '_jh' } },
          { $project: { _id: 0, jobMissing: { $eq: [{ $size: '$_jh' }, 0] } } },
        ],
        as: '_effLatestApp',
      },
    },
    {
      $set: {
        _effJobGone: {
          $or: [
            { $and: [{ $ne: ['$referralJobId', null] }, { $eq: [{ $size: '$_effRefJobHits' }, 0] }] },
            {
              $and: [
                { $eq: ['$referralPipelineStatus', 'applied'] },
                { $eq: ['$referralContext', 'JOB_APPLY'] },
                {
                  $or: [
                    { $eq: [{ $size: '$_effLatestApp' }, 0] },
                    { $eq: [{ $arrayElemAt: ['$_effLatestApp.jobMissing', 0] }, true] },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        effectiveStatus: {
          $switch: {
            branches: [
              // $type==='date' is the ONLY safe "has a real joiningDate" guard: $ne null does NOT
              // exclude missing fields here ($lte treats missing/null as < any date → false employee
              // matches). Mirrors applyLifecycleOverlay's `if (joiningDate)` real-date check.
              {
                case: {
                  $and: [
                    { $eq: [{ $type: '$joiningDate' }, 'date'] },
                    { $lte: ['$joiningDate', now] },
                    { $eq: ['$isActive', true] },
                  ],
                },
                then: 'employee',
              },
              {
                case: { $and: [{ $eq: [{ $type: '$joiningDate' }, 'date'] }, { $lte: ['$joiningDate', now] }] },
                then: 'resigned',
              },
              {
                case: { $and: ['$_effJobGone', { $not: [{ $in: ['$referralPipelineStatus', JOB_REMOVED_EXEMPT] }] }] },
                then: 'job_removed',
              },
              { case: { $eq: ['$referralPipelineStatus', 'in_review'] }, then: 'interview' },
            ],
            default: { $ifNull: ['$referralPipelineStatus', 'pending'] },
          },
        },
      },
    },
    { $unset: ['_effRefJobHits', '_effLatestApp', '_effJobGone'] },
  ];
};

/** Match on the computed `effectiveStatus`. `[]` when no status is selected. */
export const effectiveStatusMatch = (query) => {
  const sel = query?.referralPipelineStatus ? String(query.referralPipelineStatus).trim() : '';
  return sel ? [{ $match: { effectiveStatus: sel } }] : [];
};

export const listReferralLeads = async (req) => {
  const canSeeAll = await canUserSeeAllReferralLeads(req);
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const baseMatch = await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q });
  const match = { ...baseMatch, ...applyNewFilters(q) };
  if (baseMatch.$and) {
    match.$and = [...baseMatch.$and];
  }

  const ownerStages = referralLeadsRequireExistingOwnerStages();
  const statusMatch = effectiveStatusMatch(q);
  // effectiveStatus is only needed to FILTER; the row badge comes from shapeLeadRow. Skip its two
  // lookups entirely when no status is selected.
  const effStages = statusMatch.length ? buildEffectiveStatusStages(new Date()) : [];
  const pipeline = [
    { $match: match },
    ...buildSalesAgentListEnrichmentStages(),
    ...ownerStages,
    ...effStages,
    ...statusMatch,
    ...referralLeadsPopulateReferrerAndJobStages(),
    { $sort: { referredAt: -1, _id: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
  ];

  // Total uses the same match + owner filter + effective-status filter (no enrichment/populate, which
  // don't change row count), so it matches the stats card total exactly.
  const [rows, totalArr] = await Promise.all([
    Employee.aggregate(pipeline),
    Employee.aggregate([{ $match: match }, ...ownerStages, ...effStages, ...statusMatch, { $count: 'c' }]),
  ]);
  const total = totalArr[0]?.c ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const appliedJobApplyOrphans = await appliedJobPostingOrphansForJobApplyApplied(rows);
  const results = await Promise.all(rows.map((r) => shapeLeadRow(r, { appliedJobApplyOrphans })));
  return {
    results,
    page,
    limit,
    total,
    totalPages,
    staleDataWarning: false,
  };
};

const CONVERTED_STATUSES = CONVERTED_PIPELINE_STATUSES;
const PENDING_STATUSES = PENDING_PIPELINE_STATUSES;

async function computeSalesAgentStats(tenantId, filters = {}) {
  const match = { isCurrent: true, isRevoked: false };
  if (tenantId) match.tenantId = tenantId;
  if (filters.salesAgentUserId && mongoose.Types.ObjectId.isValid(String(filters.salesAgentUserId))) {
    match.salesAgentUserId = new mongoose.Types.ObjectId(String(filters.salesAgentUserId));
  }

  // Hire = candidate whose EFFECTIVE status (same overlay as rows/cards) is employee/joined — not
  // the raw stored field, which is stale for the time-driven tail. Project the candidate fields the
  // overlay needs, then filter + dedupe + rank in JS so this stays a single source of truth.
  // ponytail: loads current attribution rows for the tenant; fine at referral scale. Push the
  // overlay into a $expr $switch + server-side $group if attributions ever reach tens of thousands.
  const rows = await ReferralAttribution.aggregate([
    { $match: match },
    { $lookup: { from: 'employees', localField: 'subjectProfileId', foreignField: '_id', as: 'cand' } },
    { $unwind: '$cand' },
    {
      $project: {
        agent: '$salesAgentUserId',
        cand: '$subjectProfileId',
        status: '$cand.referralPipelineStatus',
        joiningDate: '$cand.joiningDate',
        isActive: '$cand.isActive',
      },
    },
  ]);

  const ranked = rankSalesAgentHires(rows, new Date(), 5);

  const users = await User.find({ _id: { $in: ranked.map((r) => r.userId) } })
    .select('name')
    .lean();
  const nameById = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  return ranked.map((r) => ({ userId: r.userId, name: nameById[r.userId] || 'Unknown', count: r.count }));
}

export const getReferralLeadsStats = async (req) => {
  const canSeeAll = await canUserSeeAllReferralLeads(req);
  const q = req.query || {};
  const match = { ...(await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q })), ...applyNewFilters(q) };
  const matchGlobalTop = buildGlobalTopReferrerMatch(q);

  /** Org-wide “top referrer” is sensitive; only Administrator, internal Agent, or platform super user. */
  const canSeeOrgReferrerLeaderboard = (await userIsAdmin(req.user)) || (await userIsAgent(req.user));

  const ownerStages = referralLeadsRequireExistingOwnerStages();
  const now = new Date();
  const effStages = buildEffectiveStatusStages(now);
  const statusMatch = effectiveStatusMatch(q);

  const [totalArr, statusGroups, topRef, unassignedArr, salesBoard, hireByType] = await Promise.all([
    Employee.aggregate([{ $match: match }, ...ownerStages, ...effStages, ...statusMatch, { $count: 'c' }]),
    // Funnel/cards bucket by the SAME effectiveStatus the list filters + the badge shows (includes the
    // time-driven employee/resigned tail AND job_removed), so cards always agree with the rows.
    Employee.aggregate([
      { $match: match },
      ...ownerStages,
      ...effStages,
      ...statusMatch,
      { $group: { _id: '$effectiveStatus', c: { $sum: 1 } } },
    ]),
    canSeeOrgReferrerLeaderboard
      ? Employee.aggregate([
          { $match: matchGlobalTop },
          ...ownerStages,
          { $group: { _id: '$referredByUserId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 1 },
        ])
      : Promise.resolve([]),
    Employee.aggregate([
      { $match: { ...match, currentSalesAgentUserId: null } },
      ...ownerStages,
      ...effStages,
      ...statusMatch,
      { $count: 'c' },
    ]),
    computeSalesAgentStats(req.user?.tenantId, q),
    // Referred candidates who became employees (joiningDate set), split by their own
    // compensationType (paid/unpaid). Keys off joiningDate — NOT referralPipelineStatus
    // 'hired' — so backfilled employees who joined before the candidate/job flow still count.
    // Item lists are capped at 100 for the dashboard drill-down.
    Employee.aggregate([
      { $match: { ...match, joiningDate: { $exists: true, $ne: null }, isActive: true } },
      ...ownerStages,
      ...effStages,
      ...statusMatch,
      {
        $group: {
          _id: { $ifNull: ['$compensationType', 'paid'] },
          count: { $sum: 1 },
          items: { $push: { id: '$_id', name: '$fullName', email: '$email', jobTitle: '$designation' } },
        },
      },
      { $project: { count: 1, items: { $slice: ['$items', 100] } } },
    ]),
  ]);

  const totalAgg = totalArr[0]?.c ?? 0;

  const byStatusMap = {};
  for (const g of statusGroups) byStatusMap[g._id] = g.c;
  let converted = 0;
  let pending = 0;
  const hired =
    (byStatusMap.hired || 0) + (byStatusMap.joined || 0) + (byStatusMap.employee || 0);
  for (const s of CONVERTED_STATUSES) {
    converted += byStatusMap[s] || 0;
  }
  for (const s of PENDING_STATUSES) {
    pending += byStatusMap[s] || 0;
  }

  const period = q.from || q.to ? 'filtered' : 'all_time';
  let topReferrer = null;
  if (topRef.length > 0 && topRef[0]._id) {
    const u = await User.findById(topRef[0]._id).select('name').lean();
    topReferrer = {
      userId: String(topRef[0]._id),
      name: u?.name || 'Unknown',
      count: topRef[0].count,
      period,
    };
  }

  const conversionRate = totalAgg > 0 ? Math.round((converted / totalAgg) * 1000) / 10 : 0;
  const unassignedCount = unassignedArr[0]?.c ?? 0;
  const hiresPerSalesAgent = salesBoard.map((row, idx) => ({
    userId: String(row.userId),
    name: row.name || 'Unknown',
    count: row.count,
    rank: idx + 1,
  }));

  // Paid / Unpaid by the employee's compensationType. Anything unexpected is surfaced
  // separately so the totals stay honest.
  const shapeHire = (it) => ({
    id: String(it.id),
    name: it.name || 'Unknown',
    email: it.email || '',
    jobTitle: it.jobTitle || null,
  });
  const paidBucket = hireByType.find((b) => b._id === 'paid');
  const unpaidBucket = hireByType.find((b) => b._id === 'unpaid');
  const otherBuckets = hireByType.filter((b) => b._id !== 'paid' && b._id !== 'unpaid');
  const paidHires = paidBucket?.count ?? 0;
  const unpaidHires = unpaidBucket?.count ?? 0;
  const otherHires = otherBuckets.reduce((n, b) => n + b.count, 0);
  const paidHiresList = (paidBucket?.items ?? []).map(shapeHire);
  const unpaidHiresList = (unpaidBucket?.items ?? []).map(shapeHire);
  const otherHiresList = otherBuckets.flatMap((b) => b.items || []).slice(0, 100).map(shapeHire);

  return {
    totalReferrals: totalAgg,
    converted,
    conversionRate,
    pending,
    hired,
    // Raw referralPipelineStatus counts (funnel uses these so it matches the cards exactly).
    pipelineCounts: byStatusMap,
    paidHires,
    unpaidHires,
    otherHires,
    paidHiresList,
    unpaidHiresList,
    otherHiresList,
    topReferrer,
    leaderboard: [],
    unassignedCount,
    totalReferredHires: hired,
    hiresPerSalesAgent,
    topSalesAgent: hiresPerSalesAgent[0]
      ? {
          ...hiresPerSalesAgent[0],
          leaderboardSize: hiresPerSalesAgent.length,
        }
      : null,
  };
};

export const exportReferralLeadsCsv = async (req, res) => {
  const canSeeAll = await canUserSeeAllReferralLeads(req);
  const q = { ...req.query, search: undefined };
  const match = { ...(await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q })), ...applyNewFilters(q) };
  const exportStatusMatch = effectiveStatusMatch(q);
  const cap = 5000;
  const rows = await Employee.aggregate([
    { $match: match },
    ...buildSalesAgentListEnrichmentStages(),
    ...referralLeadsRequireExistingOwnerStages(),
    ...(exportStatusMatch.length ? buildEffectiveStatusStages(new Date()) : []),
    ...exportStatusMatch,
    ...referralLeadsPopulateReferrerAndJobStages(),
    { $sort: { referredAt: -1 } },
    { $limit: cap },
  ]);

  const orgId = config.referral?.defaultOrgId || 'default';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="referral-leads.csv"');
  const header = [
    'candidate_id',
    'candidate_name',
    'candidate_email',
    'referrer_id',
    'referrer_name',
    'referrer_role',
    'referral_context',
    'job_id',
    'job_title',
    'referral_jti',
    'status',
    'referred_at',
    'attribution_locked_at',
    'org_id',
    'sales_agent_name',
    'sales_agent_email',
    'sales_agent_assigned_at',
    'sales_agent_scope',
    'lifecycle_stage',
    'employee_converted',
    'employee_status',
    'joining_date',
    'attribution_job_id',
    'attribution_job_title',
  ].join(',');
  res.write(`${header}\n`);
  for (const r of rows) {
    const ref = r.referredByUserId;
    const rid = ref?._id ? String(ref._id) : r.referredByUserId ? String(r.referredByUserId) : '';
    const rname = (ref && ref.name) || '';
    const salesAgentName = r.currentSalesAgent?.name || r.currentSalesAgent?.fullName || '';
    const salesAgentEmail = r.currentSalesAgent?.email || '';
    const line = [
      r._id,
      r.fullName,
      r.email,
      rid,
      rname,
      '',
      r.referralContext || '',
      r.referralJobId?._id || r.referralJobId || '',
      r.referralJobId?.title || r.referralJobTitle || '',
      r.referralJti || '',
      r.referralPipelineStatus || '',
      r.referredAt ? new Date(r.referredAt).toISOString() : '',
      r.attributionLockedAt ? new Date(r.attributionLockedAt).toISOString() : '',
      orgId,
      salesAgentName,
      salesAgentEmail,
      r.currentSalesAgentAssignedAt ? new Date(r.currentSalesAgentAssignedAt).toISOString() : '',
      r.currentSalesAgentJobId == null ? 'candidate' : 'job',
      r.lifecycleStage || '',
      r.employeeConverted === true ? 'true' : 'false',
      r.employeeStatus || '',
      r.joiningDate ? new Date(r.joiningDate).toISOString() : '',
      r.attributionJobId || '',
      r.referralJobId?.title || r.referralJobTitle || '',
    ];
    res.write(`${line.map((x) => csvCell(x)).join(',')}\n`);
  }
  res.end();

  try {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.REFERRAL_LEADS_EXPORT,
      EntityTypes.CANDIDATE,
      req.user.id,
      { rowCount: rows.length, filters: { ...q } },
      req
    );
  } catch (e) {
    logger.warn('referral export activity log', e);
  }
};

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const getReferralLeadById = async (candidateId, { tenantId } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(candidateId))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  const match = {
    _id: new mongoose.Types.ObjectId(String(candidateId)),
    referredByUserId: { $exists: true, $ne: null },
  };
  if (tenantId && mongoose.Types.ObjectId.isValid(String(tenantId))) {
    match.tenantId = new mongoose.Types.ObjectId(String(tenantId));
  }
  const rows = await Employee.aggregate([
    { $match: match },
    ...buildSalesAgentListEnrichmentStages(),
    ...referralLeadsPopulateReferrerAndJobStages(),
    { $limit: 1 },
  ]);
  if (!rows.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  return shapeLeadRow(rows[0]);
};

export const overrideReferralAttribution = async (req) => {
  if (await userIsSalesAgent(req.user)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Sales agents cannot override referral attribution');
  }
  const { candidateId } = req.params;
  const { newReferredByUserId, reason } = req.body;
  const reasonNorm = String(reason ?? '')
    .trim()
    .slice(0, 200);
  if (!mongoose.Types.ObjectId.isValid(newReferredByUserId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid new referrer id');
  }
  const c = await Employee.findById(candidateId);
  if (!c) throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  if (!c.referredByUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Candidate has no referral to override');
  }

  const prev = c.referredByUserId;
  if (String(prev) === String(newReferredByUserId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'New referrer is the same as the current referrer — no change made');
  }
  c.referralLastOverride = {
    previousReferredByUserId: prev,
    newReferredByUserId,
    reason: reasonNorm,
    overriddenBy: req.user._id,
    overriddenAt: new Date(),
  };
  c.referredByUserId = newReferredByUserId;
  await c.save();

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.REFERRAL_ATTRIBUTION_OVERRIDE,
    EntityTypes.CANDIDATE,
    candidateId,
    {
      previousReferredByUserId: String(prev),
      newReferredByUserId: String(newReferredByUserId),
      reason: c.referralLastOverride.reason,
      claimStage: 'attribution_override',
    },
    req
  );
  logReferralEvent('referral_attribution_overridden', {
    candidateId: String(candidateId),
    previousReferredByUserId: String(prev),
    newReferredByUserId: String(newReferredByUserId),
  });

  await c.populate([{ path: 'referredByUserId', select: 'name email' }]);
  return shapeLeadRow(c);
};
