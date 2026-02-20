import httpStatus from 'http-status';
import Placement from '../models/placement.model.js';
import { isOwnerOrAdmin } from './job.service.js';
import ApiError from '../utils/ApiError.js';

/**
 * Query placements with filter
 */
const queryPlacements = async (filter, options, currentUser) => {
  const { userIsAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) query.job = filter.jobId;
  if (filter.candidateId) query.candidate = filter.candidateId;
  if (filter.status) query.status = filter.status;
  if (filter.preBoardingStatus) query.preBoardingStatus = filter.preBoardingStatus;

  const isAdmin = await userIsAdmin(currentUser);
  if (!isAdmin && currentUser?.id) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: currentUser.id }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id);
    if (query.job) {
      if (!myJobIds.some((jid) => jid.toString() === String(query.job))) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
    } else {
      query.job = { $in: myJobIds };
    }
  }

  const result = await Placement.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'offer', select: 'offerCode status ctcBreakdown' },
      { path: 'job', select: 'title organisation' },
      { path: 'candidate', select: 'fullName email phoneNumber employeeId department designation reportingManager' },
    ],
  });

  return result;
};

/**
 * Get placement by id (with optional access check)
 */
const getPlacementById = async (id, currentUser = null) => {
  const placement = await Placement.findById(id)
    .populate('offer')
    .populate('job', 'title organisation createdBy')
    .populate('candidate', 'fullName email phoneNumber employeeId department designation reportingManager')
    .populate('createdBy', 'name email');
  if (!placement) return null;
  if (currentUser && placement.job) {
    const canAccess = await isOwnerOrAdmin(currentUser, placement.job);
    if (!canAccess) {
      const ApiError = (await import('../utils/ApiError.js')).default;
      throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
    }
  }
  return placement;
};

/**
 * Update placement status
 */
const updatePlacementStatus = async (id, updateBody, currentUser) => {
  const placement = await Placement.findById(id).populate('job');
  if (!placement) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Placement not found');
  }
  const canAccess = await isOwnerOrAdmin(currentUser, placement.job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  if (updateBody.status) {
    const valid = ['Pending', 'Joined', 'Deferred', 'Cancelled'];
    if (!valid.includes(updateBody.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${valid.join(', ')}`);
    }
    placement.status = updateBody.status;
  }
  if (updateBody.joiningDate !== undefined) {
    placement.joiningDate = new Date(updateBody.joiningDate);
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
  await placement.save();
  return getPlacementById(placement._id);
};

export { queryPlacements, getPlacementById, updatePlacementStatus };
