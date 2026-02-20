import httpStatus from 'http-status';
import JobApplication from '../models/jobApplication.model.js';
import { getJobById, isOwnerOrAdmin } from './job.service.js';
import ApiError from '../utils/ApiError.js';

const STATUS_VALUES = ['Applied', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'];

/**
 * Get job application by id
 * @param {ObjectId} id
 * @returns {Promise<JobApplication|null>}
 */
const getJobApplicationById = async (id) => {
  const application = await JobApplication.findById(id)
    .populate('job', 'title organisation status createdBy')
    .populate('candidate', 'fullName email phoneNumber')
    .populate('appliedBy', 'name email');
  return application;
};

/**
 * Update job application status (and optionally notes)
 * @param {ObjectId} id - Application id
 * @param {Object} updateBody - { status, notes? }
 * @param {Object} currentUser
 * @returns {Promise<JobApplication>}
 */
const updateJobApplicationStatus = async (id, updateBody, currentUser) => {
  const application = await JobApplication.findById(id);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }

  const job = await getJobById(application.job);
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const { status, notes } = updateBody;

  if (status != null && status !== undefined) {
    if (!STATUS_VALUES.includes(status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    application.status = status;
  }

  if (notes !== undefined) {
    application.notes = notes;
  }

  await application.save();
  await application.populate([
    { path: 'job', select: 'title organisation status' },
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'appliedBy', select: 'name email' },
  ]);

  return application;
};

/**
 * Query job applications with filter and pagination
 * @param {Object} filter - { jobId?, candidateId?, status? }
 * @param {Object} options - pagination options
 * @param {Object} currentUser - for access check (filter by job ownership if not admin)
 * @returns {Promise<QueryResult>}
 */
const queryJobApplications = async (filter, options, currentUser) => {
  const { userIsAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) {
    query.job = filter.jobId;
  }
  if (filter.candidateId) {
    query.candidate = filter.candidateId;
  }
  if (filter.status) {
    query.status = filter.status;
  }

  const isAdmin = await userIsAdmin(currentUser);
  if (!isAdmin && currentUser?.id) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: currentUser.id }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id.toString());
    if (query.job) {
      const jobStr = String(query.job);
      if (!myJobIds.includes(jobStr)) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
    } else {
      query.job = { $in: myJobs.map((j) => j._id) };
    }
  }

  const result = await JobApplication.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'job', select: 'title organisation status' },
      { path: 'candidate', select: 'fullName email phoneNumber' },
      { path: 'appliedBy', select: 'name email' },
    ],
  });

  return result;
};

export {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
  STATUS_VALUES,
};
