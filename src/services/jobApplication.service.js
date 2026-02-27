import httpStatus from 'http-status';
import JobApplication from '../models/jobApplication.model.js';
import Candidate from '../models/candidate.model.js';
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
    .populate('candidate', 'fullName email phoneNumber countryCode')
    .populate('appliedBy', 'name email');
  return application;
};

/**
 * Create a job application
 * @param {Object} body - { job, candidate, status?, coverLetter?, notes? }
 * @param {Object} currentUser
 * @returns {Promise<JobApplication>}
 */
const createJobApplication = async (body, currentUser) => {
  const job = await getJobById(body.job);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this job');
  }
  const candidate = await Candidate.findById(body.candidate);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  const existing = await JobApplication.findOne({ job: body.job, candidate: body.candidate });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'This candidate has already applied to this job');
  }
  const application = await JobApplication.create({
    job: body.job,
    candidate: body.candidate,
    status: body.status || 'Applied',
    coverLetter: body.coverLetter,
    notes: body.notes,
    appliedBy: currentUser.id,
  });
  await application.populate([
    { path: 'job', select: 'title organisation status' },
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'appliedBy', select: 'name email' },
  ]);
  return application;
};

/**
 * Update job application (status, notes, coverLetter, job, candidate)
 * @param {ObjectId} id - Application id
 * @param {Object} updateBody - { status?, notes?, coverLetter?, job?, candidate? }
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

  const { status, notes, coverLetter, job: jobId, candidate: candidateId } = updateBody;

  if (jobId != null && jobId !== undefined) {
    const newJob = await getJobById(jobId);
    if (!newJob) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
    }
    const canAccessNew = await isOwnerOrAdmin(currentUser, newJob);
    if (!canAccessNew) {
      throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to that job');
    }
    application.job = jobId;
  }
  if (candidateId != null && candidateId !== undefined) {
    const candidate = await Candidate.findById(candidateId);
    if (!candidate) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
    }
    application.candidate = candidateId;
  }
  // If job or candidate changed, check unique (job, candidate)
  const existing = await JobApplication.findOne({
    job: application.job,
    candidate: application.candidate,
    _id: { $ne: application._id },
  });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'This candidate has already applied to this job');
  }

  if (status != null && status !== undefined) {
    if (!STATUS_VALUES.includes(status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    application.status = status;
  }
  if (notes !== undefined) {
    application.notes = notes;
  }
  if (coverLetter !== undefined) {
    application.coverLetter = coverLetter;
  }

  await application.save();
  await application.populate([
    { path: 'job', select: 'title organisation status' },
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'appliedBy', select: 'name email' },
  ]);

  if (status != null && status !== undefined && application.candidate?.email) {
    const { notifyByEmail } = await import('./notification.service.js');
    const jobTitle = application.job?.title || 'Job';
    notifyByEmail(application.candidate.email, {
      type: 'job_application',
      title: `Application status: ${application.status}`,
      message: `Your application for "${jobTitle}" is now ${application.status}.`,
      link: '/ats/my-applications',
    }).catch(() => {});
  }

  return application;
};

/**
 * Delete job application
 * @param {ObjectId} id
 * @param {Object} currentUser
 * @returns {Promise<void>}
 */
const deleteJobApplication = async (id, currentUser) => {
  const application = await JobApplication.findById(id);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }
  const job = await getJobById(application.job);
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  await JobApplication.findByIdAndDelete(id);
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
      { path: 'candidate', select: 'fullName email phoneNumber countryCode' },
      { path: 'appliedBy', select: 'name email' },
    ],
  });

  return result;
};

export {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
  createJobApplication,
  deleteJobApplication,
  STATUS_VALUES,
};
