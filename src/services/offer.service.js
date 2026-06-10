import mongoose from 'mongoose';
import httpStatus from 'http-status';
import Offer from '../models/offer.model.js';
import Job from '../models/job.model.js';
import Placement from '../models/placement.model.js';
import Position from '../models/position.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Employee from '../models/employee.model.js';
import { getJobById, isOwnerOrAdmin, createJob } from './job.service.js';
import ApiError from '../utils/ApiError.js';
import { getLetterDefaultsForPositionTitle } from '../config/offerLetterRoleDefaults.js';
import { syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';
import { logActivity as logRecruiterActivity } from './recruiterActivity.service.js';
import logger from '../config/logger.js';
import { resolvePositionIdFromDesignationTitle } from './positionResolve.helper.js';
import { OFFER_STATUSES, compensationTypeForJobType } from '../constants/atsPipeline.js';
import * as emailService from './email.service.js';

const STATUS_VALUES = OFFER_STATUSES;

const DEFAULT_SUPERVISOR = {
  firstName: 'Jason',
  lastName: 'Mendonca',
  phone: '+1-307-206-9144',
  email: 'jason@dharwinbusinesssolutions.com',
};

/** Offer letter modal fields — allowed to update even when status is not Draft (CTC etc. stay locked). */
const OFFER_LETTER_FIELD_KEYS = [
  'letterFullName',
  'letterAddress',
  'positionTitle',
  'jobType',
  'weeklyHours',
  'workLocation',
  'roleResponsibilities',
  'positionOverviewHtml',
  'trainingOutcomes',
  'trainingOutcomesHtml',
  'compensationNarrative',
  'academicAlignmentNote',
  'employmentEligibilityLines',
  'supervisor',
  'letterDate',
  'joiningDate',
];

const formatAddressLine = (addr) => {
  if (!addr || typeof addr !== 'object') return '';
  const a = addr;
  const parts = [a.streetAddress, a.streetAddress2, a.city, a.state, a.zipCode, a.country].filter(
    (x) => x && String(x).trim()
  );
  return parts.join(', ');
};

const buildCompensationNarrative = (offer) => {
  const gross = offer?.ctcBreakdown?.gross;
  if (gross == null || Number.isNaN(Number(gross)) || Number(gross) <= 0) return '';
  const cur = (offer.ctcBreakdown?.currency || 'USD').toUpperCase();
  const monthly = Number(gross) / 12;
  const closing =
    'subject to all applicable federal, state, and local tax withholdings.';
  if (cur === 'USD') {
    return `You will receive a gross annual salary of $${Number(gross).toLocaleString('en-US', { maximumFractionDigits: 0 })} USD, payable in monthly installments of $${Math.round(monthly).toLocaleString('en-US', { maximumFractionDigits: 0 })} USD, ${closing}`;
  }
  if (cur === 'INR') {
    const g = Number(gross).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const m = Math.round(monthly).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    // No ₹ in generated copy — standard PDF fonts often render U+20B9 as a wrong glyph (e.g. apostrophe).
    return `You will receive a gross annual salary of ${g} INR, payable in monthly installments of ${m} INR, ${closing}`;
  }
  return `You will receive a gross annual salary of ${Number(gross).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${cur}, payable in monthly installments of ${Math.round(monthly).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${cur}, ${closing}`;
};

/** Same ordinal wording as legacy PDF pipeline (offer letter preview / validation context). */
const ordinalDay = (n) => {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
};

const formatStartDate = (d) => {
  if (!d) return 'TBD';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return 'TBD';
  const mon = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(x);
  return `${ordinalDay(x.getDate())} ${mon}, ${x.getFullYear()}`;
};

/** Strip HTML to plain lines (offer letter fallback when flat arrays are empty). */
const htmlToLines = (html) =>
  String(html || '')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
    .filter(Boolean);

/**
 * Placement-linked accepted offer for a candidate (canonical pipeline record).
 */
const resolvePlacementLinkedAcceptedOffer = async (candidateId) => {
  if (!candidateId) return null;
  const placement = await Placement.findOne({
    candidate: candidateId,
    status: { $ne: 'Cancelled' },
  })
    .sort({ updatedAt: -1 })
    .select('offer')
    .lean();
  if (!placement?.offer) return null;
  const offer = await Offer.findById(placement.offer);
  if (!offer || offer.status !== 'Accepted') return null;
  return offer;
};
/** When Accepted offer positionTitle changes, mirror to Employee designation + position. */
const syncDesignationFromAcceptedOfferToEmployee = async (offer) => {
  if (!offer || offer.status !== 'Accepted') return;
  const title = (offer.positionTitle || '').trim();
  if (!title) return;
  const cand = offer.candidate && typeof offer.candidate === 'object' && offer.candidate !== null
    ? offer.candidate._id ?? offer.candidate.id
    : offer.candidate;
  if (!cand) return;
  const positionId = await resolvePositionIdFromDesignationTitle(title);
  await Employee.findByIdAndUpdate(cand, {
    designation: title,
    ...(positionId ? { position: positionId } : {}),
  });
};

/**
 * Onboarding reads Placement.joiningDate; Employees list HRMS joining date reads Employee.joiningDate.
 * When Accepted offer joining date changes (offer letter / PATCH), mirror to placement + candidate.
 * Also resets joining reminder dedup so T-7/T-1 emails re-fire for the new date.
 */
const syncJoiningDateFromAcceptedOfferToPlacementAndEmployee = async (offer) => {
  if (!offer || offer.status !== 'Accepted') return;
  const jd = offer.joiningDate ? new Date(offer.joiningDate) : null;
  if (!jd || Number.isNaN(jd.getTime())) return;

  const oid = offer._id ?? offer.id;
  if (!oid) return;

  // BUG-4 FIX: Reset reminder dedup fields so T-7/T-1 emails fire again for the new joining date.
  await Placement.updateOne(
    { offer: oid },
    {
      $set: {
        joiningDate: jd,
        'reminderSentAt.t7': null,
        'reminderSentAt.t1Recruiter': null,
        'reminderSentAt.t1Candidate': null,
        'onboardingJoinRemindersSentAt.t1': null,
        'onboardingJoinRemindersSentAt.t0': null,
      },
    }
  );

  const cand = offer.candidate && typeof offer.candidate === 'object' && offer.candidate !== null
    ? offer.candidate._id ?? offer.candidate.id
    : offer.candidate;
  if (cand) {
    await Employee.findByIdAndUpdate(cand, { joiningDate: jd });
  }
};

const applyLetterFieldsFromUpdate = (offer, updateBody) => {
  const take = (k) => {
    if (updateBody[k] === undefined) return;
    offer[k] = updateBody[k];
    delete updateBody[k];
  };
  take('letterFullName');
  take('letterAddress');
  take('positionTitle');
  take('jobType');
  if (offer.isModified('jobType')) {
    offer.compensationType = compensationTypeForJobType(offer.jobType);
    offer.compensationSource = 'jobTypeDerived';
  }
  if (updateBody.weeklyHours !== undefined) {
    const h = Number(updateBody.weeklyHours);
    offer.weeklyHours = Number.isFinite(h) && h >= 1 && h <= 168 ? h : 40;
    delete updateBody.weeklyHours;
  }
  take('workLocation');
  if (updateBody.roleResponsibilities !== undefined) {
    offer.roleResponsibilities = Array.isArray(updateBody.roleResponsibilities) ? updateBody.roleResponsibilities : [];
    delete updateBody.roleResponsibilities;
  }
  take('positionOverviewHtml');
  if (updateBody.trainingOutcomes !== undefined) {
    offer.trainingOutcomes = Array.isArray(updateBody.trainingOutcomes) ? updateBody.trainingOutcomes : [];
    delete updateBody.trainingOutcomes;
  }
  take('trainingOutcomesHtml');
  take('compensationNarrative');
  take('academicAlignmentNote');
  if (updateBody.employmentEligibilityLines !== undefined) {
    offer.employmentEligibilityLines = Array.isArray(updateBody.employmentEligibilityLines)
      ? updateBody.employmentEligibilityLines
      : [];
    delete updateBody.employmentEligibilityLines;
  }
  if (updateBody.supervisor !== undefined) {
    const s = updateBody.supervisor && typeof updateBody.supervisor === 'object' ? updateBody.supervisor : {};
    const prev = offer.supervisor && offer.supervisor.toObject ? offer.supervisor.toObject() : offer.supervisor;
    offer.supervisor = { ...(prev || {}), ...s };
    delete updateBody.supervisor;
  }
  if (updateBody.letterDate !== undefined) {
    offer.letterDate = updateBody.letterDate ? new Date(updateBody.letterDate) : null;
    delete updateBody.letterDate;
  }
};

const toLetterContext = (offer) => {
  const job = offer.job && typeof offer.job === 'object' && offer.job.title ? offer.job : null;
  const candidate = offer.candidate && typeof offer.candidate === 'object' ? offer.candidate : null;
  const position = (offer.positionTitle && offer.positionTitle.trim()) || (job && job.title) || 'Open role';
  const fullName = (offer.letterFullName && offer.letterFullName.trim()) || (candidate && candidate.fullName) || 'Candidate';
  const addrFromEmp = formatAddressLine(candidate && candidate.address);
  const address = (offer.letterAddress && offer.letterAddress.trim()) || addrFromEmp || '';
  const jt = offer.jobType || 'FT_40';
  const isIntern = jt === 'INTERN_UNPAID';
  let weeklyHours =
    Number.isFinite(offer.weeklyHours) && offer.weeklyHours >= 1 && offer.weeklyHours <= 168 ? offer.weeklyHours : 40;
  if (jt === 'PT_25') weeklyHours = 20;
  if (jt === 'FT_40') weeklyHours = 40;
  const fromCtc = buildCompensationNarrative(offer);
  const comp =
    (fromCtc && fromCtc.trim()) ||
    (offer.compensationNarrative && String(offer.compensationNarrative).trim()) ||
    '';
  const s = offer.supervisor && (offer.supervisor.toObject ? offer.supervisor.toObject() : offer.supervisor);
  const hasSup = s && (s.firstName || s.lastName || s.email || s.phone);
  /** Same supervisor defaults as paid letters — Word template includes supervisor for all offer types. */
  const supFinal = { ...DEFAULT_SUPERVISOR, ...(hasSup ? s : {}) };
  const positionOverviewHtml = (offer.positionOverviewHtml && String(offer.positionOverviewHtml).trim()) || '';
  const trainingOutcomesHtml = (offer.trainingOutcomesHtml && String(offer.trainingOutcomesHtml).trim()) || '';
  // The offer letter is rendered FE-side from the rich *Html fields (nested
  // ul/ol/li + bold preserved). This BE context is validation-only and is also
  // passed through raw via positionOverviewHtml/trainingOutcomesHtml below.
  // Prefer the canonical HTML source for the bullet check, falling back to the
  // flat arrays only when no HTML is present (C2).
  const roleBullets = positionOverviewHtml
    ? htmlToLines(positionOverviewHtml)
    : Array.isArray(offer.roleResponsibilities)
      ? offer.roleResponsibilities.map((x) => String(x))
      : [];
  const trainingBullets = trainingOutcomesHtml
    ? htmlToLines(trainingOutcomesHtml)
    : Array.isArray(offer.trainingOutcomes)
      ? offer.trainingOutcomes.map((x) => String(x))
      : [];
  return {
    isIntern,
    jobType: jt,
    weeklyHours,
    fullName,
    address,
    positionTitle: position,
    startDateText: formatStartDate(offer.joiningDate),
    workLocation: offer.workLocation || 'Remote (USA)',
    roleBullets,
    trainingBullets: isIntern ? trainingBullets : undefined,
    positionOverviewHtml: positionOverviewHtml || undefined,
    trainingOutcomesHtml: isIntern && trainingOutcomesHtml ? trainingOutcomesHtml : undefined,
    compensation: isIntern ? undefined : comp,
    supervisor: supFinal,
    academicNote: offer.academicAlignmentNote,
    eligibilityLines: Array.isArray(offer.employmentEligibilityLines)
      ? offer.employmentEligibilityLines.map((x) => String(x).trim()).filter(Boolean)
      : [],
    /** Null when unset — PDF uses same long vs short date rules as the on-screen preview. */
    letterDate: offer.letterDate || null,
  };
};

/** Validates offer letter prerequisites and returns letter context once (single toLetterContext). */
const validateAndBuildLetterContext = (offer) => {
  const ctx = toLetterContext(offer);
  if (!ctx.address) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Letter address is required (set letter address or candidate address).');
  }
  if (!offer.joiningDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Joining date is required for the offer letter.');
  }
  if (!offer.jobType) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Job type is required (FT_40, PT_25, or INTERN_UNPAID).');
  }
  if (ctx.roleBullets.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one role / responsibility is required.');
  }
  if (ctx.isIntern) {
    if (!ctx.trainingBullets || ctx.trainingBullets.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Training / learning outcomes are required for an unpaid internship offer.');
    }
  } else if (
    !(
      Number(offer.ctcBreakdown?.gross) > 0 ||
      (offer.compensationNarrative && offer.compensationNarrative.trim())
    )
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Compensation: set annual gross CTC on the offer (letter form), or save a custom compensation narrative.'
    );
  }
  return ctx;
};

const jobHasPopulatedCreatedBy = (jobDoc) => {
  if (!jobDoc || typeof jobDoc !== 'object') return false;
  const cb = jobDoc.createdBy;
  if (cb == null) return false;
  if (typeof cb === 'object') return Boolean(cb._id ?? cb.id);
  return mongoose.Types.ObjectId.isValid(String(cb));
};

// Any ats.offers:* or ats.pre-boarding:* matrix perm bypasses the job-owner gate — same model as placements.
const OFFER_PIPELINE_PERMS = [
  'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
  'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
];
const hasOfferPipelinePerm = (currentUser) => {
  const p = currentUser?.authContext?.permissions;
  return !!(p && OFFER_PIPELINE_PERMS.some((perm) => p.has(perm)));
};

const ensureAccess = async (currentUser, offerOrJob) => {
  if (hasOfferPipelinePerm(currentUser)) return;
  let job;
  if (offerOrJob.job) {
    const j = offerOrJob.job;
    if (typeof j === 'object' && j !== null && jobHasPopulatedCreatedBy(j)) {
      job = j;
    } else {
      job = await getJobById(j?._id ?? j);
    }
  } else {
    job = offerOrJob;
  }
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
};

/** Same shape as `getOfferById` / post-generate offer document */
const OFFER_LETTER_POPULATE = [
  {
    path: 'job',
    select: 'title organisation status createdBy jobDescription description',
    populate: { path: 'createdBy', select: '_id name email' },
  },
  { path: 'candidate', select: 'fullName email phoneNumber address' },
  { path: 'jobApplication', select: 'status notes' },
  { path: 'createdBy', select: 'name email' },
];

const INTERNAL_OFFER_LETTER_JOB_TITLE = 'Offer letter (internal)';

const mapPayloadJobTypeToJobListingType = (payload) => {
  const jt = payload?.jobType;
  if (jt === 'PT_25') return 'Part-time';
  if (jt === 'INTERN_UNPAID') return 'Internship';
  return 'Full-time';
};

/**
 * When no job application is provided, create a shell job + candidate + application
 * so the offer model invariants (job, candidate, jobApplication) hold.
 * Uses one Draft “internal” job per user to avoid posting spam.
 * @param {Object} payload - same letter payload as create offer
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @returns {Promise<string>} new JobApplication id
 */
const createStandaloneApplicationForOfferLetter = async (payload, userId) => {
  const fullName = (payload.letterFullName && String(payload.letterFullName).trim()) || 'Candidate';
  const workLoc = (payload.workLocation && String(payload.workLocation).trim()) || 'Remote (USA)';

  let job = await Job.findOne({
    createdBy: userId,
    jobOrigin: 'internal',
    title: INTERNAL_OFFER_LETTER_JOB_TITLE,
  })
    .select('_id')
    .lean();

  if (!job) {
    const created = await createJob(userId, {
      organisation: { name: 'Dharwin Business Solutions' },
      title: INTERNAL_OFFER_LETTER_JOB_TITLE,
      jobDescription:
        'This internal job record is used for offer letters created without a job application. It is not a public listing.',
      jobType: mapPayloadJobTypeToJobListingType(payload),
      location: workLoc,
      status: 'Draft',
      jobOrigin: 'internal',
    });
    job = { _id: created._id };
  }

  const unique = new mongoose.Types.ObjectId();
  const email = `ol.${unique.toString()}.noreply@dharwin.offers.local`;
  const phoneNumber = '+1-000-000-0000';

  const candidate = await Employee.create({
    owner: userId,
    adminId: userId,
    fullName,
    email,
    phoneNumber,
  });

  const application = await JobApplication.create({
    job: job._id,
    candidate: candidate._id,
    // No real applicant — synthetic Employee.owner points to the admin who created the
    // offer. Leaving applicantUser NULL is mandatory so the applicant resolver never
    // leaks the admin's email into UI rows.
    applicantUser: null,
    status: 'Applied',
  });

  return application._id.toString();
};

/**
 * Create an offer from a job application
 */
const createOffer = async (jobApplicationId, payload, userId) => {
  const offerCode = await Offer.generateOfferCode();
  const applicationId = jobApplicationId
    ? jobApplicationId
    : await createStandaloneApplicationForOfferLetter(payload, userId);

  const application = await JobApplication.findById(applicationId)
    .populate('job')
    .populate('candidate');
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }
  const jobRefId = application.job?._id ?? application.job;
  const candRefId = application.candidate?._id ?? application.candidate;
  if (!jobRefId || !mongoose.Types.ObjectId.isValid(String(jobRefId))) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'The job linked to this application no longer exists or could not be loaded. Cannot create offer.'
    );
  }
  if (!candRefId || !mongoose.Types.ObjectId.isValid(String(candRefId))) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'The candidate linked to this application no longer exists or could not be loaded. Cannot create offer.'
    );
  }
  const existing = await Offer.findOne({ jobApplication: applicationId });
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'An offer already exists for this application');
  }

  const gross = payload.ctcBreakdown?.gross ?? 0;
  const ctcBreakdown = {
    base: payload.ctcBreakdown?.base ?? 0,
    hra: payload.ctcBreakdown?.hra ?? 0,
    specialAllowances: payload.ctcBreakdown?.specialAllowances ?? 0,
    otherAllowances: payload.ctcBreakdown?.otherAllowances ?? 0,
    gross,
    currency: payload.ctcBreakdown?.currency ?? 'USD',
  };

  const offer = await Offer.create({
    offerCode,
    jobApplication: applicationId,
    job: jobRefId,
    candidate: candRefId,
    status: 'Draft',
    ctcBreakdown,
    joiningDate: payload.joiningDate ? new Date(payload.joiningDate) : null,
    offerValidityDate: payload.offerValidityDate ? new Date(payload.offerValidityDate) : null,
    notes: payload.notes,
    createdBy: userId,
    ...(payload.letterFullName != null && { letterFullName: payload.letterFullName }),
    ...(payload.letterAddress != null && { letterAddress: payload.letterAddress }),
    ...(payload.positionTitle != null && { positionTitle: payload.positionTitle }),
    ...(payload.jobType != null && { jobType: payload.jobType }),
    ...(Number.isFinite(payload.weeklyHours) &&
      payload.weeklyHours >= 1 &&
      payload.weeklyHours <= 168 && { weeklyHours: payload.weeklyHours }),
    ...(payload.workLocation != null && { workLocation: payload.workLocation }),
    ...(Array.isArray(payload.roleResponsibilities) && { roleResponsibilities: payload.roleResponsibilities }),
    ...(payload.positionOverviewHtml != null && { positionOverviewHtml: payload.positionOverviewHtml }),
    ...(Array.isArray(payload.trainingOutcomes) && { trainingOutcomes: payload.trainingOutcomes }),
    ...(payload.trainingOutcomesHtml != null && { trainingOutcomesHtml: payload.trainingOutcomesHtml }),
    ...(payload.compensationNarrative != null && { compensationNarrative: payload.compensationNarrative }),
    ...(payload.academicAlignmentNote != null && { academicAlignmentNote: payload.academicAlignmentNote }),
    ...(Array.isArray(payload.employmentEligibilityLines) && { employmentEligibilityLines: payload.employmentEligibilityLines }),
    ...(payload.supervisor != null && typeof payload.supervisor === 'object' && { supervisor: payload.supervisor }),
    ...(payload.letterDate != null && { letterDate: new Date(payload.letterDate) }),
    compensationType: compensationTypeForJobType(payload.jobType),
    compensationSource: 'jobTypeDerived',
  });

  await application.updateOne({ status: 'Offered' });
  await syncReferralPipelineStatusForCandidate(candRefId);

  return getOfferById(offer._id);
};

/**
 * Get offer by id (with optional access check)
 */
const getOfferById = async (id, currentUser = null) => {
  const offer = await Offer.findById(id).populate(OFFER_LETTER_POPULATE);
  if (!offer) return null;
  if (currentUser) {
    await ensureAccess(currentUser, offer);
  }
  return offer;
};

/**
 * Update offer: Draft allows full edit; non-Draft allows status/notes/rejection + offer letter PDF fields only.
 * @param {string} id - Offer id
 * @param {Object} updateBody - Fields to update
 * @param {Object} currentUser - User performing the update
 * @param {Object} [options] - { skipAccessCheck: true } for internal flows (e.g. move from interview);
 *   skipSentNotification: true to skip the default "offer sent" in-app/email when a full offer letter was already sent.
 */
const updateOfferById = async (id, updateBody, currentUser, options = {}) => {
  const offer = await Offer.findById(id);
  if (!offer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }
  if (!options.skipAccessCheck && currentUser) {
    await ensureAccess(currentUser, offer);
  }

  if (offer.status !== 'Draft') {
    const allowed = ['status', 'notes', 'rejectionReason', ...OFFER_LETTER_FIELD_KEYS, 'ctcBreakdown'];
    const keys = Object.keys(updateBody).filter((k) => allowed.includes(k));
    updateBody = Object.fromEntries(keys.map((k) => [k, updateBody[k]]));
  }

  applyLetterFieldsFromUpdate(offer, updateBody);

  if (updateBody.ctcBreakdown) {
    const cb = updateBody.ctcBreakdown;
    offer.ctcBreakdown = {
      base: cb.base ?? offer.ctcBreakdown?.base ?? 0,
      hra: cb.hra ?? offer.ctcBreakdown?.hra ?? 0,
      specialAllowances: cb.specialAllowances ?? offer.ctcBreakdown?.specialAllowances ?? 0,
      otherAllowances: cb.otherAllowances ?? offer.ctcBreakdown?.otherAllowances ?? 0,
      gross: cb.gross ?? offer.ctcBreakdown?.gross ?? 0,
      currency: cb.currency ?? offer.ctcBreakdown?.currency ?? 'USD',
    };
    delete updateBody.ctcBreakdown;
  }

  if (updateBody.joiningDate !== undefined) {
    offer.joiningDate = updateBody.joiningDate ? new Date(updateBody.joiningDate) : null;
    delete updateBody.joiningDate;
  }
  if (updateBody.offerValidityDate !== undefined) {
    offer.offerValidityDate = updateBody.offerValidityDate ? new Date(updateBody.offerValidityDate) : null;
    delete updateBody.offerValidityDate;
  }

  if (updateBody.status) {
    const newStatus = updateBody.status;
    if (!STATUS_VALUES.includes(newStatus)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    const oldStatus = offer.status;
    offer.status = newStatus;
    if (newStatus === 'Sent' && oldStatus === 'Draft') {
      offer.sentAt = new Date();
    } else if (newStatus === 'Under Negotiation' && oldStatus !== 'Under Negotiation') {
      // Track when negotiation started for analytics and audit.
      offer.underNegotiationAt = new Date();
    } else if (newStatus === 'Accepted') {
      // B7 fix: a placement requires a joiningDate. Reject Accept transitions when no joining date is set
      // so Placement is never created with a missing/null joiningDate (Placement schema requires it).
      if (!offer.joiningDate) {
        throw new ApiError(
          httpStatus.UNPROCESSABLE_ENTITY,
          'Joining date must be set on the offer before it can be accepted.',
          true,
          '',
          { errorCode: 'OFFER_JOINING_DATE_REQUIRED' }
        );
      }
      if (oldStatus !== 'Accepted') {
        offer.acceptedAt = new Date();
        const candidate = await Employee.findById(offer.candidate)
          .select('employeeId joiningDate referredByUserId referralJti attributionLockedAt referralContext referralJobTitle')
          .lean();
        const existingPlacement = await Placement.findOne({ offer: offer._id }).select('status _id').lean();
        const needsFreshPlacement = !existingPlacement || existingPlacement.status === 'Cancelled';
        const placementBase = {
          offer: offer._id,
          candidate: offer.candidate,
          job: offer.job,
          employeeId: candidate?.employeeId || null,
          status: 'Pending',
          createdBy: offer.createdBy,
          preBoardingStatus: 'Pending',
          preBoardingTasks: [],
          onboardingTasks: [],
          referredByUserId: candidate?.referredByUserId || null,
          referralLeadJti: candidate?.referralJti || null,
          referralAttributionLockedAt: candidate?.attributionLockedAt || null,
          referralContext: candidate?.referralContext || null,
          referralJobTitle: candidate?.referralJobTitle || null,
        };
        if (offer.joiningDate) placementBase.joiningDate = offer.joiningDate;

        const employeeSnapshot = {
          compensationType: offer.compensationType || compensationTypeForJobType(offer.jobType),
          compensationSource: offer.compensationSource || 'jobTypeDerived',
        };
        if (offer.joiningDate) employeeSnapshot.joiningDate = offer.joiningDate;

        const persistAcceptLifecycle = async (session) => {
          const opts = session ? { session } : {};
          await offer.save(opts);
          if (offer.jobApplication) {
            await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Hired' }, opts);
          }
          if (needsFreshPlacement) {
            try {
              if (existingPlacement?.status === 'Cancelled') {
                await Placement.updateOne(
                  { _id: existingPlacement._id },
                  { $set: { _cancelledOfferRef: offer._id }, $unset: { offer: 1 } },
                  opts
                );
                await Placement.create([placementBase], opts);
              } else {
                await Placement.findOneAndUpdate(
                  { offer: offer._id },
                  { $setOnInsert: placementBase },
                  { upsert: true, new: false, ...opts }
                );
              }
            } catch (e) {
              if (e?.code !== 11000) throw e;
            }
          }
          await Employee.findByIdAndUpdate(offer.candidate, employeeSnapshot, opts);
        };

        const session = await mongoose.startSession();
        try {
          await session.withTransaction(() => persistAcceptLifecycle(session));
        } finally {
          session.endSession();
        }
        if (offer.jobApplication) {
          await syncReferralPipelineStatusForCandidate(offer.candidate);
        }
      }
    } else if (newStatus === 'Rejected') {
      offer.rejectedAt = new Date();
      offer.rejectionReason = updateBody.rejectionReason || '';
      await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Rejected' });
      await syncReferralPipelineStatusForCandidate(offer.candidate);
    }
    delete updateBody.status;

    const { notifyByEmail, notify, plainTextEmailBody } = await import('./notification.service.js');
    const { buildEmailHTML, buildPlainTextEmail } = await import('./email.service.js');
    const jobObj = offer.job && typeof offer.job === 'object' && offer.job.title ? offer.job : await getJobById(offer.job);
    const jobTitle = jobObj?.title || 'Job';

    // ── Format joining date as human-readable string for notifications ─────────────
    const joiningDateDisplay = offer.joiningDate
      ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(offer.joiningDate))
      : null;
    const validityDisplay = offer.offerValidityDate
      ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(offer.offerValidityDate))
      : null;

    if (newStatus === 'Sent') {
      if (!options.skipSentNotification) {
        const cand = await Employee.findById(offer.candidate).select('email fullName').lean();
        if (cand?.email) {
          const introLines = [`An offer for "${jobTitle}" has been sent to you.`];
          if (joiningDateDisplay) introLines.push(`Your proposed joining date is ${joiningDateDisplay}.`);
          if (validityDisplay) introLines.push(`Please respond by ${validityDisplay}.`);
          const msg = introLines.join(' ');
          const greetingName = cand.fullName?.trim() || 'there';
          const emailFooter =
            'This email was sent automatically by Dharwin Business Solutions because of an action in your account or a workflow initiated for you.';
          const offerEmailText = buildPlainTextEmail({
            title: 'You have received an offer',
            greeting: greetingName,
            introLines,
            footerLines: [emailFooter],
          });
          const offerEmailHtml = buildEmailHTML({
            badgeText: 'Offer letter',
            title: 'You have received an offer',
            greeting: greetingName,
            introLines,
            fallbackUrl: '',
            preheader: `Offer letter: ${jobTitle}`,
          });
          notifyByEmail(cand.email, {
            type: 'offer',
            title: 'You have received an offer',
            message: msg,
            email: {
              subject: `Offer letter: ${jobTitle}`,
              text: offerEmailText,
              html: offerEmailHtml,
            },
          }).catch(() => {});
        }
      }
      // B3 fix: log offer_sent activity.
      logRecruiterActivity(currentUser?._id || offer.createdBy, 'offer_sent', {
        candidateId: offer.candidate,
        description: `Sent offer for ${jobTitle}`,
        metadata: { offerId: offer._id, jobTitle, joiningDate: offer.joiningDate },
      }).catch((err) => logger.warn('logRecruiterActivity offer_sent:', err?.message || err));
    } else if (newStatus === 'Under Negotiation') {
      // Notify creator that candidate has entered negotiation.
      const creatorId = offer.createdBy?._id || offer.createdBy;
      if (creatorId) {
        const offersPath = '/ats/offers-placement';
        const msg = `The candidate has opened negotiations on the offer for "${jobTitle}". Review and respond.`;
        notify(creatorId, {
          type: 'offer',
          title: 'Offer under negotiation',
          message: msg,
          link: offersPath,
          email: { subject: `Offer negotiation: ${jobTitle}`, text: plainTextEmailBody(msg, offersPath) },
        }).catch(() => {});
      }
    } else if (newStatus === 'Accepted') {
      const creatorId = offer.createdBy?._id || offer.createdBy;
      if (creatorId) {
        const preBoardingPath = '/ats/pre-boarding';
        // Richer acceptance message includes joining date so the creator immediately knows
        // the start date without having to open the record.
        const joiningLine = joiningDateDisplay ? ` Joining date: ${joiningDateDisplay}.` : ' No joining date set yet.';
        const acceptMsg = `The offer for "${jobTitle}" has been accepted.${joiningLine} Pre-boarding has started.`;
        notify(creatorId, {
          type: 'offer',
          title: 'Offer accepted — pre-boarding started',
          message: acceptMsg,
          link: preBoardingPath,
          email: {
            subject: `Offer accepted: ${jobTitle}`,
            text: plainTextEmailBody(acceptMsg, preBoardingPath),
          },
        }).catch(() => {});
      }
      // B3 fix: log offer_accepted activity.
      logRecruiterActivity(currentUser?._id || creatorId, 'offer_accepted', {
        candidateId: offer.candidate,
        description: `Offer accepted for ${jobTitle}`,
        metadata: { offerId: offer._id, jobTitle, joiningDate: offer.joiningDate },
      }).catch((err) => logger.warn('logRecruiterActivity offer_accepted:', err?.message || err));
    } else if (newStatus === 'Rejected') {
      const creatorId = offer.createdBy?._id || offer.createdBy;
      if (creatorId) {
        const offersPath = '/ats/offers-placement';
        const rejMsg = `The offer for "${jobTitle}" was rejected by the candidate.`;
        notify(creatorId, {
          type: 'offer',
          title: 'Offer rejected',
          message: rejMsg,
          link: offersPath,
          email: {
            subject: `Offer rejected: ${jobTitle}`,
            text: plainTextEmailBody(rejMsg, offersPath),
          },
        }).catch(() => {});
      }
      // B3 fix: log offer_rejected activity.
      logRecruiterActivity(currentUser?._id || creatorId, 'offer_rejected', {
        candidateId: offer.candidate,
        description: `Offer rejected for ${jobTitle}`,
        metadata: { offerId: offer._id, jobTitle, rejectionReason: offer.rejectionReason || null },
      }).catch((err) => logger.warn('logRecruiterActivity offer_rejected:', err?.message || err));
    }
  }

  Object.assign(offer, updateBody);
  await offer.save();

  await syncJoiningDateFromAcceptedOfferToPlacementAndEmployee(offer);
  await syncDesignationFromAcceptedOfferToEmployee(offer);

  return getOfferById(offer._id);
};

/** Allowed fields on POST /offers/:id/generate-letter body (letter slice only; never status). */
const GENERATE_LETTER_PATCH_KEYS = [...OFFER_LETTER_FIELD_KEYS, 'ctcBreakdown'];

/**
 * Apply letter-form fields from generate-letter POST body in one save (avoids a separate PATCH).
 */
const applyOfferLetterPatchForGenerate = async (offer, rawBody) => {
  if (!rawBody || typeof rawBody !== 'object') return;

  const updateBody = { ...rawBody };
  for (const k of Object.keys(updateBody)) {
    if (!GENERATE_LETTER_PATCH_KEYS.includes(k)) {
      delete updateBody[k];
    }
  }

  if (Object.keys(updateBody).length === 0) return;

  applyLetterFieldsFromUpdate(offer, updateBody);

  if (updateBody.ctcBreakdown) {
    const cb = updateBody.ctcBreakdown;
    offer.ctcBreakdown = {
      base: cb.base ?? offer.ctcBreakdown?.base ?? 0,
      hra: cb.hra ?? offer.ctcBreakdown?.hra ?? 0,
      specialAllowances: cb.specialAllowances ?? offer.ctcBreakdown?.specialAllowances ?? 0,
      otherAllowances: cb.otherAllowances ?? offer.ctcBreakdown?.otherAllowances ?? 0,
      gross: cb.gross ?? offer.ctcBreakdown?.gross ?? 0,
      currency: cb.currency ?? offer.ctcBreakdown?.currency ?? 'USD',
    };
    delete updateBody.ctcBreakdown;
  }

  if (updateBody.joiningDate !== undefined) {
    offer.joiningDate = updateBody.joiningDate ? new Date(updateBody.joiningDate) : null;
    delete updateBody.joiningDate;
  }

  await offer.save();

  await syncJoiningDateFromAcceptedOfferToPlacementAndEmployee(offer);
  await syncDesignationFromAcceptedOfferToEmployee(offer);
};

/**
 * Query offers with filter
 */
const queryOffers = async (filter, options, currentUser) => {
  const { userIsAdmin: checkAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) query.job = filter.jobId;
  if (filter.candidateId) query.candidate = filter.candidateId;
  if (filter.status) query.status = filter.status;

  const isAdmin = await checkAdmin(currentUser);
  const rawUserId = currentUser?.id ?? currentUser?._id;
  const userId = rawUserId && mongoose.Types.ObjectId.isValid(String(rawUserId))
    ? new mongoose.Types.ObjectId(String(rawUserId))
    : rawUserId;

  if (!isAdmin && userId && !hasOfferPipelinePerm(currentUser)) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: userId }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id);
    if (query.job) {
      if (!myJobIds.some((jid) => jid.toString() === String(query.job))) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
    } else if (myJobIds.length > 0) {
      // Show offers for jobs I own OR offers I created
      query.$or = [
        { job: { $in: myJobIds } },
        { createdBy: userId },
      ];
    } else {
      // User has no jobs – show only offers they created
      query.createdBy = userId;
    }
  }

  const result = await Offer.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'job', select: 'title organisation status' },
      { path: 'candidate', select: 'fullName email phoneNumber address profilePicture employeeId department designation reportingManager' },
      { path: 'createdBy', select: 'name email' },
    ],
  });

  // Attach placement data for Accepted offers (Pre-boarding/Onboarding: status, preBoardingStatus, BGV, assets, IT access)
  // Must convert to plain objects so placement fields survive JSON serialization (toJSON only includes schema paths)
  const acceptedIds = result.results.filter((o) => o.status === 'Accepted').map((o) => o._id);
  let placementByOffer = {};
  if (acceptedIds.length > 0) {
    const placements = await Placement.find({ offer: { $in: acceptedIds } })
      .select(
        '_id offer status preBoardingStatus backgroundVerification assetAllocation itAccess deferredBy deferredAt cancelledBy cancelledAt'
      )
      .populate([{ path: 'deferredBy', select: 'name email' }, { path: 'cancelledBy', select: 'name email' }])
      .lean();
    placementByOffer = Object.fromEntries(placements.map((p) => [p.offer.toString(), p]));
  }

  result.results = result.results.map((offer) => {
    const plain = offer.toObject ? offer.toObject() : (typeof offer.toJSON === 'function' ? offer.toJSON() : { ...offer });
    if (plain.status === 'Accepted') {
      const pl = placementByOffer[String(plain._id || plain.id)];
      if (pl) {
        plain.placementId = pl._id;
        plain.placementStatus = pl.status;
        plain.placement = {
          preBoardingStatus: pl.preBoardingStatus,
          backgroundVerification: pl.backgroundVerification,
          assetAllocation: pl.assetAllocation || [],
          itAccess: pl.itAccess || [],
          deferredBy: pl.deferredBy,
          deferredAt: pl.deferredAt,
          cancelledBy: pl.cancelledBy,
          cancelledAt: pl.cancelledAt,
        };
      } else {
        plain.placementStatus = null;
      }
    }
    return plain;
  });

  return result;
};

/**
 * Delete offer (only Draft).
 * BUG-6 FIX: Also cleans up the synthetic Employee + JobApplication created by
 * createStandaloneApplicationForOfferLetter (identifiable by the noreply email pattern).
 */
const deleteOfferById = async (id, currentUser) => {
  const offer = await Offer.findById(id);
  if (!offer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }
  await ensureAccess(currentUser, offer);
  if (offer.status !== 'Draft') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft offers can be deleted');
  }

  // BUG-2 FIX: Only roll back to Interview if the application was set to Offered by createOffer.
  if (offer.jobApplication) {
    const app = await JobApplication.findById(offer.jobApplication).select('status candidate').lean();
    if (app?.status === 'Offered') {
      await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Interview' });
      await syncReferralPipelineStatusForCandidate(app.candidate);
    }
    // BUG-6 FIX: If this was a standalone offer (synthetic candidate), clean up orphan records.
    // Synthetic candidates are identifiable by their noreply@dharwin.offers.local email.
    if (app?.candidate) {
      const synthCandidate = await Employee.findById(app.candidate)
        .select('email')
        .lean();
      if (synthCandidate?.email && /\.noreply@dharwin\.offers\.local$/.test(synthCandidate.email)) {
        await JobApplication.findByIdAndDelete(offer.jobApplication);
        await Employee.findByIdAndDelete(app.candidate);
      }
    }
  }

  await offer.deleteOne();
  return offer;
};

/**
 * Validate and persist offer letter fields (POST /offers/:id/generate-letter).
 * Server-side PDF generation was removed; clients use browser print / Save as PDF only.
 *
 * B13 doc: there is no concurrent-PDF-overwrite risk because the server does NOT write the
 * binary. The legacy `offerLetterKey/Url/Hash/GeneratedAt` fields are unset here so any cached
 * S3 reference becomes stale-by-design when letter fields change. If S3 PDF storage is ever
 * reintroduced, gate the upload behind a conditional update keyed on `offerLetterHash` to keep
 * concurrent regenerates atomic.
 */
const generateOfferLetter = async (id, currentUser, letterPayload = null) => {
  const offer = await getOfferById(id, currentUser);
  if (!offer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }

  const hasPayload =
    letterPayload && typeof letterPayload === 'object' && Object.keys(letterPayload).length > 0;
  if (hasPayload) {
    await applyOfferLetterPatchForGenerate(offer, letterPayload);
  }

  const fresh = await getOfferById(id, currentUser);
  validateAndBuildLetterContext(fresh);

  const transitionToAccepted = fresh.status === 'Draft';

  // Mark letter as generated (first save stamps the date; re-saves preserve it).
  // Only unset S3 PDF refs — offerLetterGeneratedAt must NOT be unset so the
  // "Update status" action remains visible after the first save.
  const updateOp = {
    $unset: { offerLetterKey: 1, offerLetterUrl: 1, offerLetterHash: 1 },
    $set: {
      offerLetterGeneratedAt: fresh.offerLetterGeneratedAt ?? new Date(),
      ...(transitionToAccepted ? { status: 'Accepted', acceptedAt: new Date() } : {}),
    },
  };
  await Offer.findByIdAndUpdate(id, updateOp);

  // When transitioning Draft → Accepted via letter save, create the Placement record
  // (same lifecycle as updateOfferById Accepted path) so Pre-boarding link appears.
  if (transitionToAccepted) {
    const candidateId = fresh.candidate?._id ?? fresh.candidate;
    const jobId = fresh.job?._id ?? fresh.job;
    const createdById = fresh.createdBy?._id ?? fresh.createdBy;

    const candidate = await Employee.findById(candidateId)
      .select('employeeId referredByUserId referralJti attributionLockedAt referralContext referralJobTitle')
      .lean();
    const existingPlacement = await Placement.findOne({ offer: fresh._id }).select('status _id').lean();
    const needsFreshPlacement = !existingPlacement || existingPlacement.status === 'Cancelled';

    const placementBase = {
      offer: fresh._id,
      candidate: candidateId,
      job: jobId,
      employeeId: candidate?.employeeId || null,
      status: 'Pending',
      createdBy: createdById,
      preBoardingStatus: 'Pending',
      preBoardingTasks: [],
      onboardingTasks: [],
      joiningDate: fresh.joiningDate,
      referredByUserId: candidate?.referredByUserId || null,
      referralLeadJti: candidate?.referralJti || null,
      referralAttributionLockedAt: candidate?.attributionLockedAt || null,
      referralContext: candidate?.referralContext || null,
      referralJobTitle: candidate?.referralJobTitle || null,
    };

    if (needsFreshPlacement) {
      try {
        if (existingPlacement?.status === 'Cancelled') {
          await Placement.updateOne(
            { _id: existingPlacement._id },
            { $set: { _cancelledOfferRef: fresh._id }, $unset: { offer: 1 } }
          );
          await Placement.create([placementBase]);
        } else {
          await Placement.findOneAndUpdate(
            { offer: fresh._id },
            { $setOnInsert: placementBase },
            { upsert: true, new: false }
          );
        }
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }

    if (fresh.jobApplication) {
      await JobApplication.findByIdAndUpdate(fresh.jobApplication, { status: 'Hired' });
      await syncReferralPipelineStatusForCandidate(candidateId);
    }
  }

  return getOfferById(id, currentUser);
};

const getLetterDefaultsForTitle = (positionTitle) => getLetterDefaultsForPositionTitle(positionTitle);

/** Cap on derived responsibilities — long HTML descriptions otherwise explode the PDF/email. */
const MAX_ROLE_RESPONSIBILITIES = 12;

/**
 * Derive offer-letter role responsibilities from the selected job.
 * Precedence: job description (one bullet per line) → skillRequirements summary → [].
 */

/** Heading text that marks the start of the responsibilities section in a JD. */
const RESP_HEADING_RE =
  /(roles?\s*(?:&|and|&amp;)\s*responsibilit|key\s+responsibilit|responsibilit|duties|what\s+you(?:['’]| wi)ll\s+do|your\s+role)/i;
/** Any other section heading that ends the responsibilities block. */
const OTHER_HEADING_RE =
  /(requirement|qualificat|skills?|experience|about|who\s+you\s+are|benefit|perks?|compensation|education|nice\s+to\s+have|what\s+we\s+offer|eligibilit)/i;

/**
 * Pull just the Roles & Responsibilities section from a JD when one is labelled;
 * returns its bullet/line items. Empty array if no such section is found.
 */
const responsibilitiesSectionLines = (html) => {
  const blocks = String(html || '')
    // Each heading / paragraph / list-item becomes its own chunk.
    .replace(/<br\s*\/?>/gi, '</p>')
    .split(/(?=<(?:h[1-6]|p|li|ul|ol|div)\b)/i);
  let inSection = false;
  const out = [];
  for (const block of blocks) {
    const isHeading = /<(?:h[1-6]|strong|b)\b/i.test(block);
    const plain = block
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/gi, '&')
      .replace(/^[\s•\-*]+/, '')
      .trim();
    if (!plain) continue;
    if (isHeading && RESP_HEADING_RE.test(plain)) {
      inSection = true;
      continue;
    }
    if (inSection && isHeading && OTHER_HEADING_RE.test(plain)) break;
    if (inSection) out.push(plain);
  }
  return out;
};

export const deriveRoleResponsibilities = (job) => {
  if (!job) return [];
  const description = typeof job.jobDescription === 'string' ? job.jobDescription : '';
  /* Prefer the labelled Roles & Responsibilities section; fall back to the whole description. */
  const sectionLines = responsibilitiesSectionLines(description);
  const lines = sectionLines.length ? sectionLines : htmlToLines(description);
  if (lines.length) return lines.slice(0, MAX_ROLE_RESPONSIBILITIES);
  if (Array.isArray(job.skillRequirements) && job.skillRequirements.length) {
    return job.skillRequirements
      .filter((s) => s && s.name)
      .map((s) => `Apply ${s.name} in day-to-day responsibilities`)
      .slice(0, MAX_ROLE_RESPONSIBILITIES);
  }
  return [];
};

/**
 * Share a saved offer letter with the candidate by email. Idempotent (re-shares allowed).
 */
const shareOfferWithCandidate = async (id, currentUser, payload = {}) => {
  const offer = await getOfferById(id, currentUser);
  if (!offer.offerLetterGeneratedAt || !offer.offerLetterUrl) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Generate and upload the offer letter before sharing it.'
    );
  }
  const candidate = offer.candidate || {};
  const to = payload.to || candidate.email;
  if (!to) throw new ApiError(httpStatus.BAD_REQUEST, 'No candidate email to send to.');
  await emailService.sendOfferShareEmail(to, {
    candidateName: candidate.fullName,
    roleTitle: offer.positionTitle || offer.job?.title,
    offerLetterUrl: offer.offerLetterUrl,
    sharedBy: currentUser?.name || currentUser?.email,
    body: payload.body,
    subject: payload.subject,
    cc: payload.cc,
    bcc: payload.bcc,
  });
  return { sharedTo: to };
};

/**
 * EC-4: Auto-expire offers whose offerValidityDate has passed and are still Sent/Under Negotiation.
 * Called by the candidate scheduler on each run. Does NOT affect Draft/Accepted/Rejected offers.
 * @returns {Promise<number>} number of offers expired
 */
export const autoExpireOffers = async () => {
  const now = new Date();

  // Fetch IDs first so we can cascade to job applications using the same set.
  const toExpire = await Offer.find(
    {
      status: { $in: ['Sent', 'Under Negotiation'] },
      offerValidityDate: { $lt: now },
    },
    { _id: 1, jobApplication: 1 }
  ).lean();

  if (!toExpire.length) return 0;

  const offerIds = toExpire.map((o) => o._id);
  const appIds = toExpire.map((o) => o.jobApplication).filter(Boolean);

  await Offer.updateMany(
    { _id: { $in: offerIds } },
    {
      $set: {
        status: 'Rejected',
        rejectedAt: now,
        rejectionReason: 'Offer expired: validity date passed without candidate response.',
      },
    }
  );

  if (appIds.length) {
    await JobApplication.updateMany({ _id: { $in: appIds } }, { $set: { status: 'Rejected' } });
    const candidateIds = await JobApplication.distinct('candidate', { _id: { $in: appIds } });
    await Promise.all(
      candidateIds.map((cid) => syncReferralPipelineStatusForCandidate(cid).catch(() => undefined))
    );
  }

  // Notify each offer creator so they know which offers have lapsed.
  try {
    const { notify, plainTextEmailBody } = await import('./notification.service.js');
    for (const o of toExpire) {
      const creatorId = o.createdBy;
      if (!creatorId) continue;
      const jobObj = o.job && typeof o.job === 'object' ? o.job : null;
      const title = jobObj?.title || 'a role';
      const msg = `The offer for "${title}" has expired. The validity date passed without a candidate response. The offer has been automatically rejected.`;
      notify(creatorId, {
        type: 'offer',
        title: 'Offer expired automatically',
        message: msg,
        link: '/ats/offers-placement',
        email: {
          subject: `Offer expired: ${title}`,
          text: plainTextEmailBody(msg, '/ats/offers-placement'),
        },
      }).catch(() => {});
    }
  } catch (_) { /* non-fatal */ }

  return toExpire.length;
};

export {
  createOffer,
  getOfferById,
  updateOfferById,
  queryOffers,
  deleteOfferById,
  generateOfferLetter,
  getLetterDefaultsForTitle,
  shareOfferWithCandidate,
  syncJoiningDateFromAcceptedOfferToPlacementAndEmployee,
  STATUS_VALUES,
};
