import httpStatus from 'http-status';
import Placement from '../models/placement.model.js';
import Offer from '../models/offer.model.js';
import Employee from '../models/employee.model.js';
import { isOwnerOrAdmin } from './job.service.js';
import ApiError from '../utils/ApiError.js';
import { assertAgentCanReadPlacement, stripPlacementPlain } from '../utils/placementAccess.util.js';
import { recordPlacementAudit } from './placementAudit.service.js';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { placementCandidateHasDisplayIdentity } from '../utils/placementCandidateIdentity.js';
import { ALLOWED_TRANSITIONS, PLACEMENT_STATUSES } from '../constants/atsPipeline.js';
import { syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';

// Any pipeline-scope perm (15 keys across pre-boarding/onboarding/offers) grants full read
// across placements — same as admin. Used to bypass owner/job-ownership gates for non-admin
// users with explicit pipeline matrix permissions.
const PIPELINE_PERMS = [
  'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
  'onboarding.read', 'onboarding.create', 'onboarding.edit', 'onboarding.delete', 'onboarding.manage',
  'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
];
const hasAnyPipelinePerm = (currentUser) => {
  const p = currentUser?.authContext?.permissions;
  return !!(p && PIPELINE_PERMS.some((perm) => p.has(perm)));
};

/** UTC calendar day string YYYY-MM-DD for stable comparison of stored dates. */
const joinDateYmdUtc = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return x.toISOString().slice(0, 10);
};

/**
 * Accepted offer letter joining date is authoritative. If Placement (or related Employee row)
 * drifted from the Offer (e.g. sync race or legacy data), align DB + in-memory doc on read.
 * @param {import('mongoose').Document|object} doc - Placement document or plain object with populated `offer`.
 */
const reconcilePlacementJoiningDateWithAcceptedOffer = async (doc) => {
  if (!doc) return;
  const offer = typeof doc.offer === 'object' && doc.offer !== null ? doc.offer : null;
  if (!offer || offer.status !== 'Accepted' || !offer.joiningDate) return;

  const jd = new Date(offer.joiningDate);
  if (Number.isNaN(jd.getTime())) return;

  const cur = doc.joiningDate ? new Date(doc.joiningDate) : null;
  if (cur && !Number.isNaN(cur.getTime()) && joinDateYmdUtc(cur) === joinDateYmdUtc(jd)) return;

  const pid = doc._id ?? doc.id;
  if (!pid) return;

  await Placement.updateOne({ _id: pid }, { $set: { joiningDate: jd } });

  const candRef = doc.candidate && typeof doc.candidate === 'object' ? doc.candidate._id ?? doc.candidate.id : doc.candidate;
  if (candRef) {
    await Employee.findByIdAndUpdate(candRef, { joiningDate: jd });
    const empLean = await Employee.findById(candRef).select('owner').lean();
    if (empLean?.owner) {
      const Student = (await import('../models/student.model.js')).default;
      await Student.updateMany({ user: empLean.owner }, { $set: { joiningDate: jd } });
    }
  }

  doc.joiningDate = jd;
  if (typeof doc.set === 'function') doc.set('joiningDate', jd);
};

/**
 * Sync canonical joining date to Offer + Employee when placement date changes.
 * @param {import('mongoose').Document} placement
 */
const syncJoiningDateFromPlacement = async (placement) => {
  if (!placement.joiningDate) return;
  const jd = placement.joiningDate;
  const tasks = [];
  if (placement.offer) tasks.push(Offer.findByIdAndUpdate(placement.offer, { joiningDate: jd }));
  if (placement.candidate) tasks.push(Employee.findByIdAndUpdate(placement.candidate, { joiningDate: jd }));
  await Promise.all(tasks);
};

const resolveEffectiveJoiningDate = (placement, updateBody = {}) => {
  if (updateBody.joiningDate !== undefined) {
    return updateBody.joiningDate ? new Date(updateBody.joiningDate) : null;
  }
  return placement.joiningDate ?? null;
};

const tryPromotePlacementCandidateIfEligible = async (placement) => {
  if (placement.status !== 'Joined' && placement.status !== 'Onboarding') return;
  const emp = await Employee.findById(placement.candidate).select('email fullName owner joiningDate').lean();
  if (!emp?.owner && !emp?.email) return;
  if (placement.joiningDate) {
    const pY = joinDateYmdUtc(placement.joiningDate);
    const eY = emp.joiningDate ? joinDateYmdUtc(emp.joiningDate) : '';
    if (pY && pY !== eY) {
      await Employee.findByIdAndUpdate(placement.candidate, { joiningDate: placement.joiningDate });
    }
  }
  try {
    const { promoteCandidateOwnerToEmployeeRole, joinCalendarDayHasArrived } = await import(
      './employeeRolePromotion.service.js'
    );
    const effectiveJoin = placement.joiningDate ?? emp.joiningDate;
    if (!joinCalendarDayHasArrived(effectiveJoin)) return;
    await promoteCandidateOwnerToEmployeeRole(emp.owner ?? null, { employeeId: emp._id });
  } catch (e) {
    logger.warn(`promoteCandidateOwnerToEmployeeRole on onboarding placement: ${e?.message || e}`);
  }
};


const VALID_STATUS = new Set(PLACEMENT_STATUSES);

/**
 * Lifecycle:
 *   Pending    → Onboarding | Joined | Deferred | Cancelled  (pre-boarding queue; Joined kept for legacy/admin)
 *   Onboarding → Pending | Joined | Deferred | Cancelled     (pre-boarding done, pre-join window)
 *   Joined     → Deferred                                    (rare reversal)
 *   Deferred   → Pending | Onboarding | Joined | Cancelled
 *   Cancelled  → Pending | Onboarding | Deferred             (re-open)
 */
const allowedTransitions = {
  Pending: new Set(ALLOWED_TRANSITIONS.placement.Pending),
  Onboarding: new Set(ALLOWED_TRANSITIONS.placement.Onboarding),
  Joined: new Set(ALLOWED_TRANSITIONS.placement.Joined),
  Deferred: new Set(ALLOWED_TRANSITIONS.placement.Deferred),
  Cancelled: new Set(ALLOWED_TRANSITIONS.placement.Cancelled),
};

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
const canTransitionStatus = (from, to) => {
  if (from === to) return true;
  const s = allowedTransitions[from];
  return s ? s.has(to) : false;
};

/**
 * @param {import('mongoose').Document} placement
 * @returns {boolean}
 */
const isPreboardingGateSatisfied = (placement) => {
  const tasks = placement.preBoardingTasks;
  if (Array.isArray(tasks) && tasks.length > 0 && config.ats?.preboardingChecklistEnabled !== false) {
    return tasks.filter((t) => t.required).every((t) => t.done);
  }
  return placement.preBoardingStatus === 'Completed';
};

const mergeTaskList = (existing, updates) => {
  if (!Array.isArray(updates)) return existing || [];
  const byId = new Map((existing || []).map((t) => [String(t._id), { ...t }]));
  for (const u of updates) {
    if (!u || !u._id) continue;
    const id = String(u._id);
    const cur = { ...(byId.get(id) || {}), _id: u._id };
    if (u.title !== undefined) cur.title = u.title;
    if (u.required !== undefined) cur.required = u.required;
    if (u.done !== undefined) {
      cur.done = u.done;
      cur.doneAt = u.done ? new Date() : null;
    }
    if (u.order !== undefined) cur.order = u.order;
    if (!cur.title) cur.title = 'Task';
    byId.set(id, cur);
  }
  return Array.from(byId.values());
};

/**
 * Derive pre-boarding status from checklist tasks and/or workflow fields (BGV, assets, IT access).
 * Manual preBoardingStatus is legacy; UI no longer sends it (Task 17).
 * @param {object} placementLike
 * @returns {'Pending'|'In Progress'|'Completed'}
 */
const derivePreBoardingStatus = (placementLike) => {
  const tasks = placementLike?.preBoardingTasks;
  if (Array.isArray(tasks) && tasks.length > 0) {
    const required = tasks.filter((t) => t.required);
    if (required.length > 0) {
      if (required.every((t) => t.done)) return 'Completed';
      if (required.some((t) => t.done)) return 'In Progress';
      return 'Pending';
    }
  }

  const bvStatus = placementLike?.backgroundVerification?.status ?? 'Pending';
  if (bvStatus === 'Completed' || bvStatus === 'Verified') return 'Completed';
  const assets = placementLike?.assetAllocation ?? [];
  const itAccess = placementLike?.itAccess ?? [];
  if (
    bvStatus === 'In Progress' ||
    (Array.isArray(assets) && assets.length > 0) ||
    (Array.isArray(itAccess) && itAccess.length > 0)
  ) {
    return 'In Progress';
  }
  return 'Pending';
};

const recomputePreBoardingStatus = (placement) => {
  placement.preBoardingStatus = derivePreBoardingStatus(placement);
};

const plainSubdoc = (value) => {
  if (!value) return {};
  if (typeof value.toObject === 'function') return value.toObject();
  return { ...value };
};

/**
 * Merge incoming PATCH fields into a snapshot used for gate checks and persisted status derivation.
 */
const buildPreboardingSnapshot = (placement, updateBody = {}) => {
  const merged = {
    preBoardingStatus:
      updateBody.preBoardingStatus !== undefined ? updateBody.preBoardingStatus : placement.preBoardingStatus,
    preBoardingTasks: Array.isArray(updateBody.preBoardingTasks)
      ? mergeTaskList(placement.preBoardingTasks, updateBody.preBoardingTasks) || placement.preBoardingTasks
      : placement.preBoardingTasks,
    backgroundVerification: {
      ...plainSubdoc(placement.backgroundVerification),
      ...(updateBody.backgroundVerification || {}),
    },
    assetAllocation: Array.isArray(updateBody.assetAllocation)
      ? updateBody.assetAllocation
      : placement.assetAllocation || [],
    itAccess: Array.isArray(updateBody.itAccess) ? updateBody.itAccess : placement.itAccess || [],
  };
  if (updateBody.preBoardingStatus === undefined) {
    merged.preBoardingStatus = derivePreBoardingStatus(merged);
  }
  return merged;
};

/**
 * Merge incoming PATCH fields into a plain snapshot so Joined/pre-boarding gate matches what this save will persist.
 * Without this, changing workflow fields + Placement status in one request failed because gate ran on stale DB values.
 */
const snapshotPlacementForPreboardingGate = (placement, updateBody) => {
  const snap = buildPreboardingSnapshot(placement, updateBody);
  return { preBoardingStatus: snap.preBoardingStatus, preBoardingTasks: snap.preBoardingTasks };
};

/**
 * Human-readable blocker when marking Joined is not allowed (plus structured details for UI).
 */
const explainPreboardingGateBlock = (placement, updateBody, gateBasis) => {
  const checklistEnabled = config.ats?.preboardingChecklistEnabled !== false;
  const tasks = gateBasis.preBoardingTasks;

  if (Array.isArray(tasks) && tasks.length > 0 && checklistEnabled) {
    const incomplete = tasks.filter((t) => t.required && !t.done);
    const titles = incomplete.map((t) => String(t.title || 'Untitled step').trim()).filter(Boolean);
    const preview = titles.slice(0, 6).join('; ');
    const more =
      titles.length > 6 ? ` (+${titles.length - 6} more)` : '';
    const message =
      incomplete.length === 0
        ? [
            'Cannot move this hire to Joined yet.',
            '',
            'The pre-boarding checklist must be satisfied before onboarding.',
            `Effective pre-boarding status after your edits would be "${gateBasis.preBoardingStatus ?? 'Pending'}".`,
            'Finish every required checklist item below, then save again.',
          ].join('\n')
        : [
            'Cannot move this hire to Joined yet.',
            '',
            `Reason: ${incomplete.length} required pre-boarding checklist step(s) are still incomplete.`,
            preview ? `Still open: ${preview}${more}` : '',
            '',
            'What to do: scroll to Pre-boarding tasks in this form, check off each required step, then click Save.',
            'If policy allows skipping this requirement, enable “Override pre-boarding gate” (requires permission) and save.',
          ]
            .filter(Boolean)
            .join('\n');

    return {
      message,
      details: {
        gate: 'checklist',
        incompleteRequiredCount: incomplete.length,
        incompleteRequiredTaskTitles: titles,
        savedPreBoardingStatusOnRecord: placement.preBoardingStatus,
        effectivePreBoardingStatusForGate: gateBasis.preBoardingStatus,
      },
    };
  }

  const pb = gateBasis.preBoardingStatus || 'Pending';
  const targetStatus = updateBody.status === 'Onboarding' ? 'Onboarding' : 'Joined';
  const bvStatus =
    updateBody.backgroundVerification?.status ?? placement.backgroundVerification?.status ?? 'Pending';
  const message = [
    `Cannot move this hire to ${targetStatus} yet.`,
    '',
    'Reason: pre-boarding must be completed before onboarding.',
    pb !== 'Completed'
      ? `After applying your edits, pre-boarding would still be "${pb}" (currently "${placement.preBoardingStatus ?? 'Pending'}" on record).`
      : '',
    '',
    bvStatus !== 'Completed' && bvStatus !== 'Verified'
      ? 'What to do: set Background verification status to Completed (or Verified), then save again.'
      : 'What to do: finish required pre-boarding steps (background verification and any checklist items), then save again.',
    'If an approved exception applies, enable “Override pre-boarding gate” and save.',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    message,
    details: {
      gate: 'status',
      savedPreBoardingStatusOnRecord: placement.preBoardingStatus,
      effectivePreBoardingStatusForGate: pb,
      preBoardingStatusInRequest: updateBody.preBoardingStatus ?? null,
    },
  };
};

const recomputeOnboardingStatus = (placement) => {
  const tasks = placement.onboardingTasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const required = tasks.filter((t) => t.required);
  if (required.length === 0) return;
  // BUG-5 FIX: Record when all required onboarding tasks are completed.
  // This enables the frontend to show a "Onboarding complete" indicator.
  if (required.every((t) => t.done)) {
    if (!placement.onboardingCompletedAt) {
      placement.onboardingCompletedAt = new Date();
    }
  } else {
    // Reset if tasks are un-done after completion
    placement.onboardingCompletedAt = null;
  }
};

/**
 * Restrict placement query to candidates that still exist and have display identity.
 * Mutates `query` (sets `query.candidate`).
 * @returns {Promise<{ ok: boolean }>} ok false → caller should return an empty paginated result
 */
const narrowPlacementQueryToValidCandidates = async (query, filter) => {
  if (filter.candidateId) {
    const emp = await Employee.findById(filter.candidateId).select('fullName email').lean();
    if (!placementCandidateHasDisplayIdentity(emp)) {
      return { ok: false };
    }
    query.candidate = filter.candidateId;
    return { ok: true };
  }

  const candidateRefs = await Placement.distinct('candidate', query);
  if (!candidateRefs.length) {
    return { ok: false };
  }

  const employees = await Employee.find({ _id: { $in: candidateRefs } })
    .select('_id fullName email')
    .lean();

  const allowed = employees.filter(placementCandidateHasDisplayIdentity).map((e) => e._id);
  if (!allowed.length) {
    return { ok: false };
  }

  query.candidate = { $in: allowed };
  return { ok: true };
};

const emptyPaginateResult = (options) => {
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  return {
    results: [],
    page,
    limit,
    totalPages: 0,
    totalResults: 0,
  };
};

const PLACEMENT_LIST_PROMOTION_BACKFILL_MS = 60000;
let lastPlacementListPromotionBackfillAt = 0;

// Queue composition. Both queues require an Accepted offer (denormalized placement.offerStatus).
// enteredOnboardingAt is the stage discriminator for the shared off-ramp statuses.
const PRE_BOARDING_QUEUE_STATUSES = ['Pending', 'Deferred', 'Cancelled'];
const ONBOARDING_ACTIVE_STATUSES = ['Onboarding', 'Joined'];
const STAGE_OFFRAMP_STATUSES = ['Deferred', 'Cancelled'];

/** Compose AND-clauses without clobbering an existing $or (access-control uses one). */
const pushAnd = (query, clause) => {
  query.$and = (query.$and || []).concat([clause]);
};

/**
 * Build the queue query for a stage:
 *   preBoarding → offerStatus=Accepted, enteredOnboardingAt=null, status∈{Pending,Deferred,Cancelled}
 *   onboarding  → offerStatus=Accepted, status∈{Onboarding,Joined} OR
 *                 (status∈{Deferred,Cancelled} AND enteredOnboardingAt≠null)
 * `statusNarrow` (single status from the page dropdown) restricts within the stage.
 */
const applyStageFilter = (query, stage, statusNarrow) => {
  query.offerStatus = 'Accepted';
  const narrow =
    typeof statusNarrow === 'string' && statusNarrow && !statusNarrow.includes(',') ? statusNarrow : null;

  if (stage === 'preBoarding') {
    query.enteredOnboardingAt = null;
    query.status =
      narrow && PRE_BOARDING_QUEUE_STATUSES.includes(narrow) ? narrow : { $in: PRE_BOARDING_QUEUE_STATUSES };
    return;
  }

  if (stage === 'onboarding') {
    if (narrow && ONBOARDING_ACTIVE_STATUSES.includes(narrow)) {
      query.status = narrow; // Onboarding | Joined — unambiguous, no discriminator needed
    } else if (narrow && STAGE_OFFRAMP_STATUSES.includes(narrow)) {
      query.status = narrow; // Deferred | Cancelled — only the ones that reached onboarding
      query.enteredOnboardingAt = { $ne: null };
    } else {
      pushAnd(query, {
        $or: [
          { status: { $in: ONBOARDING_ACTIVE_STATUSES } },
          { status: { $in: STAGE_OFFRAMP_STATUSES }, enteredOnboardingAt: { $ne: null } },
        ],
      });
    }
  }
};

/**
 * Query placements with filter
 */
const queryPlacements = async (filter, options, currentUser) => {
  const { userIsAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) query.job = filter.jobId;
  if (filter.stage) {
    // Stage owns the status/offerStatus/discriminator clause; filter.status narrows within it.
    applyStageFilter(query, filter.stage, filter.status);
  } else if (filter.status) {
    const raw = String(filter.status);
    if (raw.includes(',')) {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => VALID_STATUS.has(s));
      if (parts.length === 1) query.status = parts[0];
      else if (parts.length > 1) query.status = { $in: parts };
    } else {
      query.status = filter.status;
    }
  }
  if (filter.preBoardingStatus) query.preBoardingStatus = filter.preBoardingStatus;

  const isAdmin = await userIsAdmin(currentUser);
  const rawUserId = currentUser?.id ?? currentUser?._id;
  const userId = rawUserId && String(rawUserId).match(/^[0-9a-fA-F]{24}$/) ? rawUserId : null;
  // Any pipeline-scope perm grants full-list visibility — same as admin.
  const hasPipelineReadScope = hasAnyPipelinePerm(currentUser);
  if (!isAdmin && !hasPipelineReadScope && userId) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: userId }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id);
    if (query.job) {
      const jobAllowed = myJobIds.some((jid) => jid.toString() === String(query.job));
      if (!jobAllowed) {
        query.createdBy = userId;
      }
    } else {
      // $and-wrapped so it composes with a stage $or (onboarding queue) instead of clobbering it.
      pushAnd(query, { $or: [{ job: { $in: myJobIds } }, { createdBy: userId }] });
    }
  }

  const narrow = await narrowPlacementQueryToValidCandidates(query, filter);
  if (!narrow.ok) {
    return emptyPaginateResult(options);
  }

  const result = await Placement.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'offer', select: 'offerCode status ctcBreakdown joiningDate' },
      { path: 'job', select: 'title organisation' },
      { path: 'candidate', select: 'fullName email phoneNumber employeeId department designation reportingManager' },
      { path: 'deferredBy', select: 'name email' },
      { path: 'cancelledBy', select: 'name email' },
    ],
  });

  if (result.results?.length) {
    await Promise.all(result.results.map((d) => reconcilePlacementJoiningDateWithAcceptedOffer(d)));
  }

  // Add daysUntilJoining as a convenience field for the frontend timeline/countdown.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  for (const doc of result.results || []) {
    const plain = doc.toObject ? doc.toObject() : doc;
    if (plain.joiningDate) {
      const jd = new Date(plain.joiningDate);
      jd.setUTCHours(0, 0, 0, 0);
      plain.daysUntilJoining = Math.round((jd - todayUtc) / (24 * 60 * 60 * 1000));
    } else {
      plain.daysUntilJoining = null;
    }
    Object.assign(doc, { daysUntilJoining: plain.daysUntilJoining });
  }

  if (result.results && currentUser) {
    const { userIsAdmin } = await import('../utils/roleHelpers.js');
    if (await userIsAdmin(currentUser)) {
      result.results = result.results.map((doc) => {
        const plain = doc.toObject ? doc.toObject() : { ...doc };
        stripPlacementPlain(plain);
        return plain;
      });
    }
  }

  const statusFilterRaw = filter.status ? String(filter.status) : '';
  if (/Onboarding|Joined/.test(statusFilterRaw)) {
    const now = Date.now();
    if (now - lastPlacementListPromotionBackfillAt > PLACEMENT_LIST_PROMOTION_BACKFILL_MS) {
      lastPlacementListPromotionBackfillAt = now;
      import('./employeeRolePromotion.service.js')
        .then(({ promoteAllEligibleCandidateOwnersFromScheduler }) => promoteAllEligibleCandidateOwnersFromScheduler())
        .catch((e) => logger.warn(`onboarding list promotion backfill: ${e?.message || e}`));
    }
  }

  return result;
};

const maybeStripSingle = async (placement, currentUser) => {
  if (!currentUser) return placement;
  const { userIsAdmin, userIsAgent } = await import('../utils/roleHelpers.js');
  if (await userIsAdmin(currentUser)) {
    const plain = placement.toObject ? placement.toObject() : { ...placement };
    stripPlacementPlain(plain);
    return plain;
  }
  if (await userIsAgent(currentUser)) {
    await assertAgentCanReadPlacement(currentUser, placement);
    const plain = placement.toObject ? placement.toObject() : { ...placement };
    stripPlacementPlain(plain);
    return plain;
  }
  return placement;
};

/**
 * Get placement by id (with optional access check)
 */
const getPlacementById = async (id, currentUser = null) => {
  const placement = await Placement.findById(id)
    .populate('offer')
    .populate('job', 'title organisation createdBy')
    .populate('candidate', 'fullName email phoneNumber employeeId department designation reportingManager')
    .populate('createdBy', 'name email')
    .populate('deferredBy', 'name email')
    .populate('cancelledBy', 'name email');
  if (!placement) return null;

  if (!placementCandidateHasDisplayIdentity(placement.candidate)) {
    return null;
  }

  await reconcilePlacementJoiningDateWithAcceptedOffer(placement);

  if (currentUser) {
    const createdByMe = String(placement.createdBy) === String(currentUser.id ?? currentUser._id);
    if (!hasAnyPipelinePerm(currentUser) && !createdByMe && placement.job) {
      const canAccess = await isOwnerOrAdmin(currentUser, placement.job);
      if (!canAccess) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
      }
    }
  }
  return maybeStripSingle(placement, currentUser);
};

/**
 * @param {import('mongoose').Types.ObjectId|string} id
 * @param {object} currentUser
 */
const listAuditForPlacementId = async (id, currentUser) => {
  const placement = await Placement.findById(id);
  if (!placement) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Placement not found');
  }
  const createdByMe = String(placement.createdBy) === String(currentUser?.id ?? currentUser?._id);
  const canAccess =
    hasAnyPipelinePerm(currentUser)
    || createdByMe
    || (placement.job && (await isOwnerOrAdmin(currentUser, placement.job)));
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const { listAuditForPlacement } = await import('./placementAudit.service.js');
  return listAuditForPlacement(placement._id);
};

/**
 * @param {object} body
 * @param {object} currentUser
 * @param {boolean} canOverridePreboardingGate - user has preboarding.override (or candidates.manage)
 */
const updatePlacementStatus = async (id, updateBody, currentUser, canOverridePreboardingGate = false) => {
  const wantsGateBypass = Boolean(updateBody.preboardingGateBypass);
  const placement = await Placement.findById(id).populate('job');
  if (!placement) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Placement not found');
  }
  const createdByMe = String(placement.createdBy) === String(currentUser?.id ?? currentUser?._id);
  const canAccess =
    hasAnyPipelinePerm(currentUser)
    || createdByMe
    || (placement.job && (await isOwnerOrAdmin(currentUser, placement.job)));
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  // Safeguard: a placement with no offer is structurally invalid (offer is required + unique).
  // Such a doc could only exist from the legacy re-accept detach bug. Refuse to mutate it with a
  // clean 422 instead of letting placement.save() throw a raw 500 ValidationError. Run the dated
  // migration to repair existing orphans; the re-accept path no longer detaches the offer.
  if (!placement.offer) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'This placement is not linked to an offer and cannot be updated. Re-accept the offer to restore the candidate.',
      true,
      '',
      { errorCode: 'PLACEMENT_OFFER_MISSING' }
    );
  }

  const previousStatus = placement.status;
  const actorId = currentUser?.id ?? currentUser?._id;
  let joiningDateChangedForNotify = false;

  if (updateBody.status) {
    if (!VALID_STATUS.has(updateBody.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${[...VALID_STATUS].join(', ')}`);
    }
    if (!canTransitionStatus(previousStatus, updateBody.status)) {
      throw new ApiError(
        httpStatus.UNPROCESSABLE_ENTITY,
        `Invalid status transition: ${previousStatus} → ${updateBody.status}`,
        true,
        '',
        { errorCode: 'PLACEMENT_STATUS_TRANSITION_INVALID' }
      );
    }
    // B4 fix: gate now enforced for both → Onboarding and → Joined.
    // Previously only Joined was gated, allowing Pending → Onboarding to enter the onboarding stage
    // (and set `onboardingCompletedAt`) while pre-boarding tasks were still incomplete.
    if (updateBody.status === 'Onboarding' || updateBody.status === 'Joined') {
      const effectiveJoiningDate = resolveEffectiveJoiningDate(placement, updateBody);
      if (updateBody.status === 'Joined' && !effectiveJoiningDate) {
        throw new ApiError(
          httpStatus.UNPROCESSABLE_ENTITY,
          'Joining date is required before marking as Joined',
          true,
          '',
          { errorCode: 'JOINING_DATE_REQUIRED' }
        );
      }
      const gateBasis = snapshotPlacementForPreboardingGate(placement, updateBody);
      const gateOk = isPreboardingGateSatisfied(gateBasis);
      const allowBypass = wantsGateBypass && canOverridePreboardingGate;
      if (!gateOk && !allowBypass) {
        const { message, details } = explainPreboardingGateBlock(placement, updateBody, gateBasis);
        throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, message, true, '', {
          errorCode: 'PREBOARDING_INCOMPLETE',
          details,
        });
      }
      if (!gateOk && allowBypass) {
        await recordPlacementAudit({
          placementId: placement._id,
          action: 'PREBOARDING_GATE_BYPASSED',
          actorId,
          fromValue: String(previousStatus),
          toValue: String(updateBody.status),
          details: {
            preBoardingStatus: placement.preBoardingStatus,
            effectiveSnapshotPreBoardingStatus: gateBasis.preBoardingStatus,
          },
        });
      }
      // Stage discriminator: stamp the first time this placement enters Onboarding (also on a
      // legacy Pending→Joined jump). Set once, never cleared — it's what keeps a later
      // Deferred/Cancelled in the Onboarding queue instead of falling back to Pre-Boarding.
      if (!placement.enteredOnboardingAt) {
        placement.enteredOnboardingAt = new Date();
      }
      if (updateBody.status === 'Joined') {
        placement.joinedAt = new Date();
      }
    }
    if (updateBody.status !== previousStatus) {
      if (updateBody.status === 'Deferred') {
        placement.deferredBy = actorId;
        placement.deferredAt = new Date();
      }
      if (updateBody.status === 'Cancelled') {
        placement.cancelledBy = actorId;
        placement.cancelledAt = new Date();
      }
      if (previousStatus === 'Cancelled' && (updateBody.status === 'Pending' || updateBody.status === 'Deferred')) {
        placement.cancelledBy = null;
        placement.cancelledAt = null;
        if (updateBody.status === 'Pending') {
          placement.deferredBy = null;
          placement.deferredAt = null;
        }
      }
    }
    placement.status = updateBody.status;
  }

  if (updateBody.joiningDate !== undefined) {
    const prevY = placement.joiningDate ? joinDateYmdUtc(placement.joiningDate) : '';
    placement.joiningDate = updateBody.joiningDate ? new Date(updateBody.joiningDate) : null;
    await syncJoiningDateFromPlacement(placement);
    const nextY = placement.joiningDate ? joinDateYmdUtc(placement.joiningDate) : '';
    if (nextY && nextY !== prevY) {
      joiningDateChangedForNotify = true;
      // Reset ALL reminder dedup flags so the full T-7 / T-1 / T-0 sequence fires again.
      placement.set('reminderSentAt', { t7: null, t1Recruiter: null, t1Candidate: null, t1ByAgent: {} });
      placement.set('onboardingJoinRemindersSentAt', { t1: null, t0: null });
    }
  }
  if (updateBody.notes !== undefined) {
    placement.notes = updateBody.notes;
  }
  if (updateBody.backgroundVerification && typeof updateBody.backgroundVerification === 'object') {
    if (!placement.backgroundVerification) {
      placement.backgroundVerification = { status: 'Pending' };
    }
    const bv = updateBody.backgroundVerification;
    if (bv.status !== undefined) placement.backgroundVerification.status = bv.status;
    if (bv.requestedAt !== undefined) placement.backgroundVerification.requestedAt = bv.requestedAt ? new Date(bv.requestedAt) : null;
    if (bv.completedAt !== undefined) placement.backgroundVerification.completedAt = bv.completedAt ? new Date(bv.completedAt) : null;
    if (bv.verifiedBy !== undefined) placement.backgroundVerification.verifiedBy = bv.verifiedBy || null;
    if (bv.agency !== undefined) placement.backgroundVerification.agency = bv.agency;
    if (bv.notes !== undefined) placement.backgroundVerification.notes = bv.notes;
  }
  if (Array.isArray(updateBody.assetAllocation)) {
    placement.assetAllocation = updateBody.assetAllocation.map((a) => ({
      name: a.name,
      type: a.type,
      serialNumber: a.serialNumber,
      allocatedAt: a.allocatedAt ? new Date(a.allocatedAt) : new Date(),
      notes: a.notes,
    }));
  }
  if (Array.isArray(updateBody.itAccess)) {
    placement.itAccess = updateBody.itAccess.map((a) => ({
      system: a.system,
      accessLevel: a.accessLevel,
      provisionedAt: a.provisionedAt ? new Date(a.provisionedAt) : new Date(),
      notes: a.notes,
    }));
  }
  if (Array.isArray(updateBody.preBoardingTasks)) {
    placement.preBoardingTasks = mergeTaskList(placement.preBoardingTasks, updateBody.preBoardingTasks) || placement.preBoardingTasks;
  }
  if (updateBody.preBoardingStatus) {
    placement.preBoardingStatus = updateBody.preBoardingStatus;
  } else if (
    Array.isArray(updateBody.preBoardingTasks) ||
    (updateBody.backgroundVerification && typeof updateBody.backgroundVerification === 'object') ||
    Array.isArray(updateBody.assetAllocation) ||
    Array.isArray(updateBody.itAccess)
  ) {
    recomputePreBoardingStatus(placement);
  }
  if (Array.isArray(updateBody.onboardingTasks)) {
    placement.onboardingTasks = mergeTaskList(placement.onboardingTasks, updateBody.onboardingTasks) || placement.onboardingTasks;
    recomputeOnboardingStatus(placement);
  }
  if (updateBody.suppressCandidateNotifications !== undefined) {
    placement.suppressCandidateNotifications = Boolean(updateBody.suppressCandidateNotifications);
  }

  await placement.save();

  if (joiningDateChangedForNotify) {
    try {
      const { sendJoiningDateFinalizedEmails } = await import('./onboardingJoiningNotifications.service.js');
      await sendJoiningDateFinalizedEmails(placement._id);
    } catch (e) {
      logger.warn(`sendJoiningDateFinalizedEmails: ${e?.message || e}`);
    }
  }

  // ── Milestone notifications ────────────────────────────────────────────────────
  // Fire when pre-boarding tasks drive preBoardingStatus to Completed for the first time.
  if (
    Array.isArray(updateBody.preBoardingTasks) &&
    placement.preBoardingStatus === 'Completed'
  ) {
    try {
      const { notify, plainTextEmailBody } = await import('./notification.service.js');
      const emp = await Employee.findById(placement.candidate).select('fullName').lean();
      const candName = emp?.fullName || 'The candidate';
      const creatorId = placement.createdBy;
      if (creatorId) {
        const msg = `${candName} has completed all pre-boarding tasks and is ready to join. You can now mark them as Joined.`;
        notify(creatorId, {
          type: 'placement_update',
          title: 'Pre-boarding complete',
          message: msg,
          link: '/ats/pre-boarding',
          email: {
            subject: `Pre-boarding complete: ${candName}`,
            text: plainTextEmailBody(msg, '/ats/pre-boarding'),
          },
        }).catch(() => {});
      }
    } catch (e) {
      logger.warn(`preBoardingComplete notify: ${e?.message || e}`);
    }
  }

  // Fire when onboarding tasks are all done for the first time in this save.
  if (
    Array.isArray(updateBody.onboardingTasks) &&
    placement.onboardingCompletedAt &&
    placement.isModified('onboardingCompletedAt')
  ) {
    try {
      const { notify, plainTextEmailBody } = await import('./notification.service.js');
      const emp = await Employee.findById(placement.candidate).select('fullName referredByUserId').lean();
      const candName = emp?.fullName || 'The candidate';
      const creatorId = placement.createdBy;
      if (creatorId) {
        const msg = `${candName} has completed all onboarding tasks. Their onboarding is now complete.`;
        notify(creatorId, {
          type: 'placement_update',
          title: 'Onboarding complete',
          message: msg,
          link: '/ats/onboarding',
          email: {
            subject: `Onboarding complete: ${candName}`,
            text: plainTextEmailBody(msg, '/ats/onboarding'),
          },
        }).catch(() => {});
      }
      // B1 fix: notify the original referrer when their referral completes onboarding.
      if (emp?.referredByUserId && String(emp.referredByUserId) !== String(creatorId)) {
        const referrerMsg = `Your referral ${candName} has completed onboarding.`;
        notify(emp.referredByUserId, {
          type: 'placement_update',
          title: 'Your referral completed onboarding',
          message: referrerMsg,
          link: '/ats/onboarding',
          email: {
            subject: `Your referral ${candName} is fully onboarded`,
            text: plainTextEmailBody(referrerMsg, '/ats/onboarding'),
          },
        }).catch(() => {});
      }
    } catch (e) {
      logger.warn(`onboardingComplete notify: ${e?.message || e}`);
    }
  }

  if (updateBody.status && updateBody.status !== previousStatus) {
    await recordPlacementAudit({
      placementId: placement._id,
      action: 'PLACEMENT_STATUS_CHANGED',
      actorId,
      fromValue: String(previousStatus),
      toValue: String(updateBody.status),
    });
  }

  if (placement.status === 'Joined' && previousStatus !== 'Joined') {
    const { notify, plainTextEmailBody } = await import('./notification.service.js');
    const { assignDefaultTrainingOnJoined } = await import('./placementTrainingHook.service.js');
    const emp = await Employee.findById(placement.candidate).select('email fullName referredByUserId owner').lean();
    if (emp?.referredByUserId) {
      try {
        const { createActivityLog } = await import('./activityLog.service.js');
        const { ActivityActions, EntityTypes } = await import('../config/activityLog.js');
        const jobRef = placement.job;
        const jobIdStr =
          jobRef && typeof jobRef === 'object' && jobRef._id
            ? String(jobRef._id)
            : placement.job
              ? String(placement.job)
              : null;
        await createActivityLog(
          String(actorId),
          ActivityActions.REFERRAL_HIRE_JOINED,
          EntityTypes.CANDIDATE,
          String(placement.candidate),
          {
            placementId: String(placement._id),
            jobId: jobIdStr,
            referrerUserId: String(emp.referredByUserId),
            claimStage: 'placement_joined',
          },
          null
        );
      } catch (e) {
        const log = (await import('../config/logger.js')).default;
        log.warn(`referral hire joined activity log failed: ${e?.message || e}`);
      }
      // B1 fix: notify the original referrer when their referral has joined.
      if (String(emp.referredByUserId) !== String(placement.createdBy)) {
        try {
          const referrerMsg = `Your referral ${emp.fullName || 'a candidate'} has joined the company.`;
          notify(emp.referredByUserId, {
            type: 'placement_update',
            title: 'Your referral has joined',
            message: referrerMsg,
            link: '/ats/onboarding',
            email: {
              subject: `Your referral ${emp.fullName || 'a candidate'} has joined`,
              text: plainTextEmailBody(referrerMsg, '/ats/onboarding'),
            },
          }).catch(() => {});
        } catch (e) {
          const log = (await import('../config/logger.js')).default;
          log.warn(`referrer hire-joined notify failed: ${e?.message || e}`);
        }
      }
    }
    if (!placement.suppressCandidateNotifications) {
      if (emp?.email) {
        const path = '/ats/onboarding';
        const msg = 'Welcome! Your joining record is now active.';
        notify(placement.createdBy, {
          type: 'placement_update',
          title: 'Placement joined',
          message: `Candidate ${emp.fullName || ''} moved to Joined`,
          link: path,
        }).catch(() => {});
        // eslint-disable-next-line import/no-extraneous-dependencies
        const emailMod = await import('./notification.service.js');
        emailMod.notifyByEmail(emp.email, {
          type: 'placement_update',
          title: 'You have joined',
          message: msg,
          link: path,
          email: { subject: 'Welcome', text: plainTextEmailBody(msg, path) },
        }).catch(() => {});
      }
    }
    // EC-7 FIX: Guard against double training assignment on Deferred → Joined re-entry.
    if (!placement.trainingAssignedAt) {
      try {
        await assignDefaultTrainingOnJoined(placement);
      } catch (e) {
        const log = (await import('../config/logger.js')).default;
        log.warn(`assignDefaultTrainingOnJoined failed: ${e?.message || e}`);
      }
    }
  }

  const justJoined = placement.status === 'Joined' && previousStatus !== 'Joined';
  const joiningDateUpdated = updateBody.joiningDate !== undefined;
  if (
    (placement.status === 'Joined' || placement.status === 'Onboarding') &&
    (justJoined || joiningDateUpdated || updateBody.status !== undefined)
  ) {
    await tryPromotePlacementCandidateIfEligible(placement);
  }

  if (placement.candidate) {
    await syncReferralPipelineStatusForCandidate(placement.candidate).catch((e) =>
      logger.warn(`syncReferralPipelineStatusForCandidate: ${e?.message || e}`)
    );
  }

  return getPlacementById(placement._id, currentUser);
};

export {
  queryPlacements,
  getPlacementById,
  updatePlacementStatus,
  listAuditForPlacementId,
  syncJoiningDateFromPlacement,
  derivePreBoardingStatus,
  snapshotPlacementForPreboardingGate,
  isPreboardingGateSatisfied,
};
