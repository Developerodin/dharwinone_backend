import mongoose from 'mongoose';
import httpStatus from 'http-status';
import Offer from '../models/offer.model.js';
import Placement from '../models/placement.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Candidate from '../models/candidate.model.js';
import { getJobById, isOwnerOrAdmin } from './job.service.js';
import ApiError from '../utils/ApiError.js';

const STATUS_VALUES = ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected'];

const ensureAccess = async (currentUser, offerOrJob) => {
  const job = offerOrJob.job ? await getJobById(offerOrJob.job) : offerOrJob;
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
};

/**
 * Create an offer from a job application
 */
const createOffer = async (jobApplicationId, payload, userId) => {
  const offerCode = await Offer.generateOfferCode();
  const application = await JobApplication.findById(jobApplicationId)
    .populate('job')
    .populate('candidate');
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }
  const existing = await Offer.findOne({ jobApplication: jobApplicationId });
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
    jobApplication: jobApplicationId,
    job: application.job._id,
    candidate: application.candidate._id,
    status: 'Draft',
    ctcBreakdown,
    joiningDate: payload.joiningDate ? new Date(payload.joiningDate) : null,
    offerValidityDate: payload.offerValidityDate ? new Date(payload.offerValidityDate) : null,
    notes: payload.notes,
    createdBy: userId,
  });

  await application.updateOne({ status: 'Offered' });

  return getOfferById(offer._id);
};

/**
 * Get offer by id (with optional access check)
 */
const getOfferById = async (id, currentUser = null) => {
  const offer = await Offer.findById(id)
    .populate('job', 'title organisation status')
    .populate('candidate', 'fullName email phoneNumber')
    .populate('jobApplication', 'status notes')
    .populate('createdBy', 'name email');
  if (!offer) return null;
  if (currentUser) {
    await ensureAccess(currentUser, offer);
  }
  return offer;
};

/**
 * Update offer (only Draft can be fully edited)
 * @param {string} id - Offer id
 * @param {Object} updateBody - Fields to update
 * @param {Object} currentUser - User performing the update
 * @param {Object} [options] - { skipAccessCheck: true } for internal flows (e.g. move from interview)
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
    const allowed = ['status', 'notes', 'rejectionReason'];
    const keys = Object.keys(updateBody).filter((k) => allowed.includes(k));
    updateBody = Object.fromEntries(keys.map((k) => [k, updateBody[k]]));
  }

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
      offer.acceptedAt = new Date();
      await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Hired' });
      const candidate = await Candidate.findById(offer.candidate).select('employeeId joiningDate').lean();
      await Placement.create({
        offer: offer._id,
        candidate: offer.candidate,
        job: offer.job,
        joiningDate: offer.joiningDate || new Date(),
        employeeId: candidate?.employeeId || null,
        status: 'Pending',
        createdBy: offer.createdBy,
      });
      if (offer.joiningDate) {
        await Candidate.findByIdAndUpdate(offer.candidate, { joiningDate: offer.joiningDate });
      }
    } else if (newStatus === 'Rejected') {
      offer.rejectedAt = new Date();
      offer.rejectionReason = updateBody.rejectionReason || '';
      await JobApplication.findByIdAndUpdate(offer.jobApplication, { status: 'Rejected' });
    }
    delete updateBody.status;
  }

  Object.assign(offer, updateBody);
  await offer.save();

  return getOfferById(offer._id);
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
      { path: 'candidate', select: 'fullName email phoneNumber profilePicture employeeId department designation reportingManager' },
      { path: 'createdBy', select: 'name email' },
    ],
  });

  // Attach placement data for Accepted offers (Pre-boarding/Onboarding: status, preBoardingStatus, BGV, assets, IT access)
  // Must convert to plain objects so placement fields survive JSON serialization (toJSON only includes schema paths)
  const acceptedIds = result.results.filter((o) => o.status === 'Accepted').map((o) => o._id);
  let placementByOffer = {};
  if (acceptedIds.length > 0) {
    const placements = await Placement.find({ offer: { $in: acceptedIds } })
      .select('offer status preBoardingStatus backgroundVerification assetAllocation itAccess')
      .lean();
    placementByOffer = Object.fromEntries(placements.map((p) => [p.offer.toString(), p]));
  }

  result.results = result.results.map((offer) => {
    const plain = offer.toObject ? offer.toObject() : (typeof offer.toJSON === 'function' ? offer.toJSON() : { ...offer });
    if (plain.status === 'Accepted') {
      const pl = placementByOffer[String(plain._id || plain.id)];
      if (pl) {
        plain.placementStatus = pl.status;
        plain.placement = {
          preBoardingStatus: pl.preBoardingStatus,
          backgroundVerification: pl.backgroundVerification,
          assetAllocation: pl.assetAllocation || [],
          itAccess: pl.itAccess || [],
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

export {
  createOffer,
  getOfferById,
  updateOfferById,
  queryOffers,
  deleteOfferById,
  STATUS_VALUES,
};
