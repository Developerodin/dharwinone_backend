import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import Candidate from '../models/candidate.model.js';
import JobApplication from '../models/jobApplication.model.js';
import {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
  createJobApplication,
  deleteJobApplication,
} from '../services/jobApplication.service.js';

const get = catchAsync(async (req, res) => {
  const application = await getJobApplicationById(req.params.applicationId);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }
  res.send(application);
});

const updateStatus = catchAsync(async (req, res) => {
  const application = await updateJobApplicationStatus(
    req.params.applicationId,
    req.body,
    req.user
  );
  res.send(application);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['jobId', 'candidateId', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryJobApplications(filter, options, req.user);
  res.send(result);
});

const getMyApplications = catchAsync(async (req, res) => {
  const candidate = await Candidate.findOne({ owner: req.user._id });
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No candidate profile found');
  }
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const filter = { candidate: candidate._id };
  if (req.query.status) filter.status = req.query.status;

  const result = await JobApplication.paginate(filter, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'job', select: 'title organisation status location jobType' },
      { path: 'candidate', select: 'fullName email' },
      { path: 'appliedBy', select: 'name email' },
    ],
  });
  res.send(result);
});

const WITHDRAWABLE_STATUSES = ['Applied', 'Screening'];

const withdrawApplication = catchAsync(async (req, res) => {
  const candidate = await Candidate.findOne({ owner: req.user._id });
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No candidate profile found');
  }
  const application = await JobApplication.findById(req.params.applicationId);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Application not found');
  }
  if (String(application.candidate) !== String(candidate._id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Not your application');
  }
  if (!WITHDRAWABLE_STATUSES.includes(application.status)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot withdraw application in "${application.status}" status`
    );
  }
  await JobApplication.findByIdAndDelete(application._id);
  res.status(httpStatus.NO_CONTENT).send();
});

const create = catchAsync(async (req, res) => {
  const application = await createJobApplication(req.body, req.user);
  res.status(httpStatus.CREATED).send(application);
});

const remove = catchAsync(async (req, res) => {
  await deleteJobApplication(req.params.applicationId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { get, updateStatus, list, getMyApplications, withdrawApplication, create, remove };
