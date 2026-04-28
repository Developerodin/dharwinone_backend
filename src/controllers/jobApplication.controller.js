import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import JobApplication from '../models/jobApplication.model.js';
import {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
  createJobApplication,
  deleteJobApplication,
} from '../services/jobApplication.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { syncReferralPipelineAfterApplicationWithdrawal } from '../services/referralLeads.service.js';

/** Owner row, or email match (public-apply candidates use job creator as owner). */
const findApplicantCandidate = async (user) => {
  const userId = user._id || user.id;
  let candidate = await Employee.findOne({ owner: userId });
  if (!candidate) {
    const emailNorm = String(user.email || '').toLowerCase().trim();
    if (emailNorm) {
      candidate = await Employee.findOne({ email: emailNorm });
    }
  }
  return candidate;
};

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
  const aid = application?._id ?? application?.id ?? req.params.applicationId;
  await activityLogService.createActivityLog(
    String(req.user.id || req.user._id),
    ActivityActions.JOB_APPLICATION_UPDATE,
    EntityTypes.JOB_APPLICATION,
    String(aid),
    { status: application?.status },
    req
  );
  res.send(application);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['jobId', 'candidateId', 'status', 'activeJobsOnly']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryJobApplications(filter, options, req.user);
  res.send(result);
});

const getMyApplications = catchAsync(async (req, res) => {
  const userId = req.user._id || req.user.id;
  const candidate = await findApplicantCandidate(req.user);
  /** Self-apply rows always set `appliedBy`; candidate profile may be missing for some portal roles yet applications exist. */
  const orBranches = [{ appliedBy: userId }];
  if (candidate) {
    orBranches.push({ candidate: candidate._id });
  }
  const filter = { $or: orBranches };
  if (req.query.status) filter.status = req.query.status;

  const options = pick(req.query, ['sortBy', 'limit', 'page']);

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
  const userId = String(req.user._id || req.user.id);
  const candidate = await findApplicantCandidate(req.user);
  const application = await JobApplication.findById(req.params.applicationId);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Application not found');
  }
  const matchesCandidate = candidate && String(application.candidate) === String(candidate._id);
  const matchesAppliedBy = application.appliedBy != null && String(application.appliedBy) === userId;
  if (!matchesCandidate && !matchesAppliedBy) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Not your application');
  }
  if (!WITHDRAWABLE_STATUSES.includes(application.status)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot withdraw application in "${application.status}" status`
    );
  }
  const candidateId = application.candidate;
  const withdrawnJobId = application.job;
  await JobApplication.findByIdAndDelete(application._id);
  await syncReferralPipelineAfterApplicationWithdrawal(candidateId, { withdrawnJobId });
  await activityLogService.createActivityLog(
    String(req.user.id || req.user._id),
    ActivityActions.JOB_APPLICATION_DELETE,
    EntityTypes.JOB_APPLICATION,
    String(application._id),
    { withdrawn: true },
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

const create = catchAsync(async (req, res) => {
  const application = await createJobApplication(req.body, req.user);
  const aid = application?._id ?? application?.id;
  if (aid) {
    await activityLogService.createActivityLog(
      String(req.user.id || req.user._id),
      ActivityActions.JOB_APPLICATION_CREATE,
      EntityTypes.JOB_APPLICATION,
      String(aid),
      {},
      req
    );
  }
  res.status(httpStatus.CREATED).send(application);
});

const remove = catchAsync(async (req, res) => {
  await deleteJobApplication(req.params.applicationId, req.user);
  await activityLogService.createActivityLog(
    String(req.user.id || req.user._id),
    ActivityActions.JOB_APPLICATION_DELETE,
    EntityTypes.JOB_APPLICATION,
    req.params.applicationId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

export { get, updateStatus, list, getMyApplications, withdrawApplication, create, remove };
