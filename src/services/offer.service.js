import { createHash } from 'crypto';
import mongoose from 'mongoose';
import httpStatus from 'http-status';
import Offer from '../models/offer.model.js';
import Job from '../models/job.model.js';
import Placement from '../models/placement.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Employee from '../models/employee.model.js';
import { getJobById, isOwnerOrAdmin, createJob } from './job.service.js';
import ApiError from '../utils/ApiError.js';
import { buildOfferLetterPdfBuffer, formatStartDate } from './offerLetterPdf.service.js';
import { uploadPdfBuffer, getObjectBufferByKey } from './fileStorage.service.js';
import { getLetterDefaultsForPositionTitle } from '../config/offerLetterRoleDefaults.js';

const STATUS_VALUES = ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected'];

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
  'trainingOutcomes',
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
  if (updateBody.weeklyHours !== undefined) {
    offer.weeklyHours = [25, 40].includes(Number(updateBody.weeklyHours)) ? Number(updateBody.weeklyHours) : 40;
    delete updateBody.weeklyHours;
  }
  take('workLocation');
  if (updateBody.roleResponsibilities !== undefined) {
    offer.roleResponsibilities = Array.isArray(updateBody.roleResponsibilities) ? updateBody.roleResponsibilities : [];
    delete updateBody.roleResponsibilities;
  }
  if (updateBody.trainingOutcomes !== undefined) {
    offer.trainingOutcomes = Array.isArray(updateBody.trainingOutcomes) ? updateBody.trainingOutcomes : [];
    delete updateBody.trainingOutcomes;
  }
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
  let weeklyHours = [25, 40].includes(offer.weeklyHours) ? offer.weeklyHours : 40;
  if (jt === 'PT_25') weeklyHours = 25;
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
  const roleBullets = Array.isArray(offer.roleResponsibilities) ? offer.roleResponsibilities.map((x) => String(x)) : [];
  const trainingBullets = Array.isArray(offer.trainingOutcomes) ? offer.trainingOutcomes.map((x) => String(x)) : [];
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

/**
 * Stable hash of PDF input from an already-built letter context.
 * When letterDate is unset, PDF uses "today" — include calendar day so a new day triggers rebuild.
 */
const letterPdfContentHashFromCtx = (ctx) => {
  const dateStamp =
    ctx.letterDate != null
      ? `fixed:${new Date(ctx.letterDate).toISOString().slice(0, 10)}`
      : `implicitDay:${new Date().toISOString().slice(0, 10)}`;
  return createHash('sha256').update(JSON.stringify(ctx)).update(dateStamp).digest('hex');
};

/** Validates offer letter prerequisites and returns PDF context once (single toLetterContext). */
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

const ensureAccess = async (currentUser, offerOrJob) => {
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
    select: 'title organisation status createdBy',
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
    currency: payload.ctcBreakdown?.currency ?? 'INR',
  };

  const offer = await Offer.create({
    offerCode,
    jobApplication: applicationId,
    job: application.job._id,
    candidate: application.candidate._id,
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
    ...([25, 40].includes(payload.weeklyHours) && { weeklyHours: payload.weeklyHours }),
    ...(payload.workLocation != null && { workLocation: payload.workLocation }),
    ...(Array.isArray(payload.roleResponsibilities) && { roleResponsibilities: payload.roleResponsibilities }),
    ...(Array.isArray(payload.trainingOutcomes) && { trainingOutcomes: payload.trainingOutcomes }),
    ...(payload.compensationNarrative != null && { compensationNarrative: payload.compensationNarrative }),
    ...(payload.academicAlignmentNote != null && { academicAlignmentNote: payload.academicAlignmentNote }),
    ...(Array.isArray(payload.employmentEligibilityLines) && { employmentEligibilityLines: payload.employmentEligibilityLines }),
    ...(payload.supervisor != null && typeof payload.supervisor === 'object' && { supervisor: payload.supervisor }),
    ...(payload.letterDate != null && { letterDate: new Date(payload.letterDate) }),
  });

  await application.updateOne({ status: 'Offered' });

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
      currency: cb.currency ?? offer.ctcBreakdown?.currency ?? 'INR',
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
    } else if (newStatus === 'Accepted') {
      if (oldStatus !== 'Accepted') {
        offer.acceptedAt = new Date();
      }
      if (offer.jobApplication) {
        await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Hired' });
      }
      const candidate = await Employee.findById(offer.candidate).select('employeeId joiningDate').lean();
      const hasPlacement = await Placement.exists({ offer: offer._id });
      if (!hasPlacement) {
        try {
          await Placement.create({
            offer: offer._id,
            candidate: offer.candidate,
            job: offer.job,
            joiningDate: offer.joiningDate || null,
            employeeId: candidate?.employeeId || null,
            status: 'Pending',
            createdBy: offer.createdBy,
          });
        } catch (e) {
          /* Unique index on offer: idempotent on duplicate accept / concurrent requests */
          if (e?.code !== 11000) throw e;
        }
      }
      if (offer.joiningDate) {
        await Employee.findByIdAndUpdate(offer.candidate, { joiningDate: offer.joiningDate });
      }
    } else if (newStatus === 'Rejected') {
      offer.rejectedAt = new Date();
      offer.rejectionReason = updateBody.rejectionReason || '';
      await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Rejected' });
    }
    delete updateBody.status;

    const { notifyByEmail, notify, plainTextEmailBody } = await import('./notification.service.js');
    const jobObj = offer.job && typeof offer.job === 'object' && offer.job.title ? offer.job : await getJobById(offer.job);
    const jobTitle = jobObj?.title || 'Job';
    if (newStatus === 'Sent') {
      if (!options.skipSentNotification) {
        const cand = await Employee.findById(offer.candidate).select('email').lean();
        if (cand?.email) {
          const msg = `An offer for "${jobTitle}" has been sent to you.`;
          notifyByEmail(cand.email, {
            type: 'offer',
            title: 'Offer sent to you',
            message: msg,
            link: '/ats/offers-placement',
            email: {
              subject: `Offer: ${jobTitle}`,
              text: plainTextEmailBody(msg, '/ats/offers-placement'),
            },
          }).catch(() => {});
        }
      }
    } else if (newStatus === 'Accepted' || newStatus === 'Rejected') {
      const creatorId = offer.createdBy?._id || offer.createdBy;
      if (creatorId) {
        const offersPath = '/ats/offers-placement';
        const offerUpdMsg = `The offer for "${jobTitle}" was ${newStatus.toLowerCase()} by the candidate.`;
        notify(creatorId, {
          type: 'offer',
          title: `Offer ${newStatus.toLowerCase()}`,
          message: offerUpdMsg,
          link: offersPath,
          email: {
            subject: `Offer ${newStatus}: ${jobTitle}`,
            text: plainTextEmailBody(offerUpdMsg, offersPath),
          },
        }).catch(() => {});
      }
    }
  }

  Object.assign(offer, updateBody);
  await offer.save();

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
      currency: cb.currency ?? offer.ctcBreakdown?.currency ?? 'INR',
    };
    delete updateBody.ctcBreakdown;
  }

  if (updateBody.joiningDate !== undefined) {
    offer.joiningDate = updateBody.joiningDate ? new Date(updateBody.joiningDate) : null;
    delete updateBody.joiningDate;
  }

  await offer.save();
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

  if (!isAdmin && userId) {
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
 * Delete offer (only Draft)
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
  await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Interview' });
  await offer.deleteOne();
  return offer;
};

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

  const ctx = validateAndBuildLetterContext(offer);
  const newHash = letterPdfContentHashFromCtx(ctx);
  if (offer.offerLetterKey && offer.offerLetterHash === newHash) {
    return offer;
  }

  const buf = await buildOfferLetterPdfBuffer(ctx);
  const userId = currentUser?.id ?? currentUser?._id;
  const { key } = await uploadPdfBuffer(userId, buf, 'offer-letters/');

  const updated = await Offer.findByIdAndUpdate(
    id,
    {
      offerLetterKey: key,
      offerLetterGeneratedAt: new Date(),
      offerLetterHash: newHash,
    },
    { new: true }
  ).populate(OFFER_LETTER_POPULATE);

  if (!updated) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }
  return updated;
};

const getOfferLetterFileBuffer = async (id, currentUser) => {
  const offer = await getOfferById(id, currentUser);
  if (!offer?.offerLetterKey) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer letter has not been generated yet');
  }
  const buffer = await getObjectBufferByKey(offer.offerLetterKey);
  const filename = `Offer-Letter-${offer.offerCode || id}.pdf`;
  return { buffer, filename };
};

const getLetterDefaultsForTitle = (positionTitle) => getLetterDefaultsForPositionTitle(positionTitle);

export {
  createOffer,
  getOfferById,
  updateOfferById,
  queryOffers,
  deleteOfferById,
  generateOfferLetter,
  getOfferLetterFileBuffer,
  getLetterDefaultsForTitle,
  STATUS_VALUES,
};
