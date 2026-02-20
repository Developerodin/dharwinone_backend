import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
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

export { get, updateStatus, list };
