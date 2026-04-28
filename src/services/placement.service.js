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

const VALID_STATUS = new Set(['Pending', 'Joined', 'Deferred', 'Cancelled']);

const allowedTransitions = {
  Pending: new Set(['Joined', 'Deferred', 'Cancelled']),
  Joined: new Set(['Deferred']),
  Deferred: new Set(['Pending', 'Joined', 'Cancelled']),
  /** Re-open a cancelled hire back into the pre-boarding queue. */
  Cancelled: new Set(['Pending', 'Deferred']),
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

const recomputePreBoardingStatus = (placement) => {
  const tasks = placement.preBoardingTasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const required = tasks.filter((t) => t.required);
  if (required.length === 0) return;
  if (required.every((t) => t.done)) placement.preBoardingStatus = 'Completed';
  else if (required.some((t) => t.done)) placement.preBoardingStatus = 'In Progress';
  else placement.preBoardingStatus = 'Pending';
};

const recomputeOnboardingStatus = (placement) => {
  const tasks = placement.onboardingTasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const required = tasks.filter((t) => t.required);
  if (required.length === 0) return;
  if (required.every((t) => t.done)) {
    // keep placement.status as Joined; tasks complete is informational
  }
};

/**
 * Pre-boarding / onboarding lists: hide placements whose Employee (candidate) no longer exists
 * or has no displayable name/email (deleted candidate, empty stub, or removed profile).
 * @param {object|null|undefined} emp - Populated Employee or lean doc
 * @returns {boolean}
 */
const placementCandidateHasDisplayIdentity = (emp) => {
  if (!emp || !emp._id) return false;
  const fn = String(emp.fullName ?? '').trim();
  const em = String(emp.email ?? '').trim();
  const bad = new Set(['-', '—', 'n/a', 'na', 'none', 'tbd']);
  if (fn.length > 0 && !bad.has(fn.toLowerCase())) return true;
  if (em.length > 0 && !bad.has(em.toLowerCase()) && em.includes('@')) return true;
  return false;
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

/**
 * Query placements with filter
 */
const queryPlacements = async (filter, options, currentUser) => {
  const { userIsAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) query.job = filter.jobId;
  if (filter.status) {
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
  if (!isAdmin && userId) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: userId }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id);
    if (query.job) {
      const jobAllowed = myJobIds.some((jid) => jid.toString() === String(query.job));
      if (!jobAllowed) {
        query.createdBy = userId;
      }
    } else {
      query.$or = [{ job: { $in: myJobIds } }, { createdBy: userId }];
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
    if (!createdByMe && placement.job) {
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
  const canAccess = createdByMe || (placement.job && (await isOwnerOrAdmin(currentUser, placement.job)));
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
  const canAccess = createdByMe || (placement.job && (await isOwnerOrAdmin(currentUser, placement.job)));
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
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
    if (updateBody.status === 'Joined') {
      if (!placement.joiningDate) {
        throw new ApiError(
          httpStatus.UNPROCESSABLE_ENTITY,
          'Joining date is required before marking as Joined',
          true,
          '',
          { errorCode: 'JOINING_DATE_REQUIRED' }
        );
      }
      const allowBypass = wantsGateBypass && canOverridePreboardingGate;
      if (!isPreboardingGateSatisfied(placement) && !allowBypass) {
        throw new ApiError(
          httpStatus.UNPROCESSABLE_ENTITY,
          'Pre-boarding must be completed before joining',
          true,
          '',
          { errorCode: 'PREBOARDING_INCOMPLETE' }
        );
      }
      if (!isPreboardingGateSatisfied(placement) && allowBypass) {
        await recordPlacementAudit({
          placementId: placement._id,
          action: 'PREBOARDING_GATE_BYPASSED',
          actorId,
          fromValue: String(previousStatus),
          toValue: 'Joined',
          details: { preBoardingStatus: placement.preBoardingStatus },
        });
      }
      placement.joinedAt = new Date();
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
      placement.set('onboardingJoinRemindersSentAt', { t1: null, t0: null });
    }
  }
  if (updateBody.notes !== undefined) {
    placement.notes = updateBody.notes;
  }
  if (updateBody.preBoardingStatus) {
    placement.preBoardingStatus = updateBody.preBoardingStatus;
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
    try {
      if (emp?.owner) {
        const { promoteCandidateOwnerToEmployeeRole } = await import('./employeeRolePromotion.service.js');
        await promoteCandidateOwnerToEmployeeRole(emp.owner);
      }
    } catch (e) {
      const log = (await import('../config/logger.js')).default;
      log.warn(`promoteCandidateOwnerToEmployeeRole on Joined: ${e?.message || e}`);
    }
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
    }
    if (!placement.suppressCandidateNotifications) {
      if (emp?.email) {
        const path = '/ats/onboarding';
        const msg = 'Welcome! Your joining record is now active.';
        notify(placement.createdBy, {
          type: 'placement',
          title: 'Placement joined',
          message: `Candidate ${emp.fullName || ''} moved to Joined`,
          link: path,
        }).catch(() => {});
        // eslint-disable-next-line import/no-extraneous-dependencies
        const emailMod = await import('./notification.service.js');
        emailMod.notifyByEmail(emp.email, {
          type: 'placement',
          title: 'You have joined',
          message: msg,
          link: path,
          email: { subject: 'Welcome', text: plainTextEmailBody(msg, path) },
        }).catch(() => {});
      }
    }
    try {
      await assignDefaultTrainingOnJoined(placement);
    } catch (e) {
      const log = (await import('../config/logger.js')).default;
      log.warn(`assignDefaultTrainingOnJoined failed: ${e?.message || e}`);
    }
  }

  return getPlacementById(placement._id, currentUser);
};

export { queryPlacements, getPlacementById, updatePlacementStatus, listAuditForPlacementId, syncJoiningDateFromPlacement };
