import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import bolnaService from '../services/bolna.service.js';
import { initiateCandidateVerificationCall } from '../services/bolnaCandidateVerification.service.js';
import { initiateJobPostingVerificationCall } from '../services/bolnaJobPostingVerification.service.js';
import callRecordService from '../services/callRecord.service.js';
import { getJobById } from '../services/job.service.js';
import Job from '../models/job.model.js';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhonePlausible, isPlaceholderPhone } from '../utils/phone.js';

const initiateCall = catchAsync(async (req, res) => {
  const body = req.body;
  const contactLabel = body.candidateName || body.name;
  if (!contactLabel) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'candidateName or name is required');
  }
  if (!body.jobId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'jobId is required for job posting verification call');
  }

  const job = await getJobById(body.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.jobOrigin === 'external') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Job posting verification calls are not available for external listings.');
  }

  const dbPhone = job.organisation?.phone;
  if (body.phone && dbPhone) {
    const clientN = normalizePhone(String(body.phone).trim());
    const dbN = normalizePhone(String(dbPhone).trim());
    if (clientN && dbN && clientN !== dbN) {
      logger.warn(
        `[Bolna job posting] Client phone differs from job.organisation.phone; dialing DB number for job ${job._id}`
      );
    }
  }

  const result = await initiateJobPostingVerificationCall({
    agentId: config.bolna.agentId,
    job,
    contactLabel,
    fromPhoneNumber: body.fromPhoneNumber,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to initiate call');
  }
  if (result.executionId) {
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          verificationCallExecutionId: result.executionId,
          verificationCallInitiatedAt: new Date(),
        },
      }
    );
    // Seed a minimal record immediately so recruiter/job calls never remain uncategorized.
    await callRecordService.updateCallRecordByExecutionId(
      result.executionId,
      {
        purpose: 'job_posting_verification',
        job: job._id,
        status: 'initiated',
      },
      { upsert: true }
    );
  }
  res.status(httpStatus.OK).send({
    success: true,
    executionId: result.executionId,
    message: 'Call initiated successfully',
  });
});

const initiateCandidateCall = catchAsync(async (req, res) => {
  const {
    candidateId,
    phoneNumber,
    countryCode,
    jobId,
    jobTitle,
    companyName,
  } = req.body;

  const Employee = (await import('../models/employee.model.js')).default;
  const candidate = await Employee.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  const job = await getJobById(jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }

  const rawPhone = phoneNumber || candidate.phoneNumber;
  if (isPlaceholderPhone(rawPhone)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Candidate does not have a real phone number on file. Update the candidate profile with a valid mobile number before initiating a call.'
    );
  }

  const cc = countryCode || candidate.countryCode || '';
  const formattedPhone = normalizePhone(String(rawPhone), cc);

  if (!formattedPhone) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid phone number format');
  }
  if (!validatePhonePlausible(formattedPhone)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Phone number ${formattedPhone} is not a valid callable line. Please update the candidate profile with a real mobile number.`
    );
  }

  const candidateAgentId = config.bolna.candidateAgentId;

  logger.info('Initiating candidate verification call: ' + JSON.stringify({
    candidateId,
    candidateName: candidate.fullName,
    phone: formattedPhone,
    jobId,
    jobTitle: jobTitle || job.title,
  }));

  const result = await initiateCandidateVerificationCall({
    agentId: candidateAgentId,
    formattedPhone,
    candidate,
    job,
    application: null,
    jobTitleOverride: jobTitle,
    companyNameOverride: companyName,
  });

  if (!result.success) {
    const msg = result.error || 'Failed to initiate call';
    const isClientPhone =
      typeof msg === 'string' &&
      (msg.toLowerCase().includes('not valid') ||
        msg.toLowerCase().includes('invalid') ||
        msg.toLowerCase().includes('callable line'));
    throw new ApiError(isClientPhone ? httpStatus.BAD_REQUEST : httpStatus.BAD_GATEWAY, msg);
  }

  // Create call record via webhook-style payload
  const CallRecord = (await import('../models/callRecord.model.js')).default;
  await CallRecord.create({
    executionId: result.executionId,
    recipientPhoneNumber: formattedPhone,
    purpose: 'job_application_verification',
    candidate: candidateId,
    job: jobId,
    status: 'initiated',
  });

  // Update JobApplication with call details
  const JobApplication = (await import('../models/jobApplication.model.js')).default;
  await JobApplication.updateOne(
    { candidate: candidateId, job: jobId },
    {
      $set: {
        verificationCallExecutionId: result.executionId,
        verificationCallStatus: 'initiated',
        verificationCallInitiatedAt: new Date(),
      },
    }
  );

  logger.info(`Candidate verification call initiated: ${result.executionId}`);

  res.status(httpStatus.OK).send({
    success: true,
    executionId: result.executionId,
    message: 'Candidate verification call initiated successfully',
  });
});

const getCallStatus = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  const result = await bolnaService.getExecutionDetails(executionId);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to fetch call status');
  }
  res.status(httpStatus.OK).send({
    success: true,
    details: result.details,
  });
});

const getCallRecords = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id?.toString();
  const isAdmin = await userIsAdmin(req.user);
  const options = {
    page: req.query.page,
    limit: req.query.limit,
    search: req.query.search,
    status: req.query.status,
    language: req.query.language,
    sortBy: req.query.sortBy,
    order: req.query.order,
    userId,
    isAdmin,
  };
  const data = await callRecordService.listCallRecords(options);
  res.status(httpStatus.OK).send({
    success: true,
    records: data.results,
    total: data.total,
    totalPages: data.totalPages,
    page: data.page,
    limit: data.limit,
  });
});

const syncMissingCallRecords = catchAsync(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const backfill = await callRecordService.backfillFromBolna({ maxPages: 2 });
  const sync = await callRecordService.syncMissingData(limit);
  res.status(httpStatus.OK).send({
    success: true,
    backfilled: backfill.backfilled,
    synced: sync.synced,
    errors: backfill.errors + sync.errors,
    message: `Backfilled ${backfill.backfilled} record(s) from Bolna, synced ${sync.synced} with transcript/recording.`,
  });
});

const deleteCallRecord = catchAsync(async (req, res) => {
  const record = await callRecordService.deleteCallRecord(req.params.id);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call record not found');
  }
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Call record deleted',
  });
});

async function sendPostCallEmailAndNotification(record, application) {
  if (!record?.executionId || !application) return;
  const callStatus = record.status || 'pending';
  const endedStatuses = ['completed', 'failed', 'no_answer', 'busy', 'error', 'call_disconnected'];
  const isEnded = endedStatuses.some((s) => String(callStatus).toLowerCase().includes(s));
  if (!isEnded) return;

  const JobApplication = (await import('../models/jobApplication.model.js')).default;
  const Employee = (await import('../models/employee.model.js')).default;
  const Job = (await import('../models/job.model.js')).default;
  const User = (await import('../models/user.model.js')).default;

  let appCallStatus = 'completed';
  if (['failed', 'error'].some((s) => String(callStatus).toLowerCase().includes(s))) appCallStatus = 'failed';
  else if (['no_answer', 'busy'].some((s) => String(callStatus).toLowerCase().includes(s))) appCallStatus = 'no_answer';

  await JobApplication.findByIdAndUpdate(application._id, { $set: { verificationCallStatus: appCallStatus } });

  const candidate = await Employee.findById(application.candidate);
  const job = await Job.findById(application.job);
  if (!candidate || !job) {
    logger.warn('Post-call email skipped: candidate or job not found');
    return;
  }

  const CallRecord = (await import('../models/callRecord.model.js')).default;
  const recordId = record._id;
  if (!recordId) {
    logger.warn('Post-call email skipped: call record has no _id');
    return;
  }
  const claim = await CallRecord.updateOne(
    { _id: recordId, postCallFollowUpSent: { $ne: true } },
    { $set: { postCallFollowUpSent: true } }
  );
  if (claim.modifiedCount === 0) {
    return;
  }

  try {
    const config = (await import('../config/config.js')).default;
    const loginUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/authentication/sign-in/`;
    const portalUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/public-job/`;
    const otherJobsCount = await Job.countDocuments({ status: 'Active', _id: { $ne: job._id } });

    const { sendPostCallThankYouEmail } = await import('../services/email.service.js');
    await sendPostCallThankYouEmail(candidate.email, {
      candidateName: candidate.fullName,
      jobTitle: job.title,
      companyName: job.organisation?.name || 'Our Company',
      jobType: job.jobType,
      jobLocation: job.location,
      loginUrl,
      callDuration: record.duration ?? null,
      otherJobsCount,
      portalUrl,
    });
    logger.info(`Post-call thank-you email sent to ${candidate.email}`);

    const user = await User.findOne({ email: candidate.email.toLowerCase() });
    if (user) {
      const { createNotification } = await import('../services/notification.service.js');
      await createNotification(user._id, {
        type: 'general',
        title: 'Thank you for your call!',
        message: `We appreciate you taking the time to speak with us about the ${job.title} position at ${job.organisation?.name || 'our company'}. Our team will review your responses and get back to you soon.`,
        link: '/ats/jobs/',
      });
      logger.info(`Post-call notification sent to ${candidate.fullName}`);
    }
  } catch (err) {
    await CallRecord.updateOne({ _id: recordId }, { $set: { postCallFollowUpSent: false } });
    logger.error(`Failed to send post-call email/notification: ${err.message}`);
  }
}

const receiveWebhook = catchAsync(async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      error: 'Body must be a JSON object',
    });
  }
  const record = await callRecordService.createFromWebhook(payload);

  // Fallback: if this webhook is for a candidate call (executionId matches JobApplication), send email
  if (record.executionId) {
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    const application = await JobApplication.findOne({ verificationCallExecutionId: record.executionId })
      .select('candidate job')
      .lean();
    if (application) {
      sendPostCallEmailAndNotification(record, application).catch((err) =>
        logger.error(`Post-call email fallback error: ${err.message}`)
      );
    }
  }

  res.status(httpStatus.OK).send({
    success: true,
    id: record._id?.toString(),
    executionId: record.executionId,
    message: 'Webhook received and stored',
  });
});

const receiveCandidateWebhook = catchAsync(async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      error: 'Body must be a JSON object',
    });
  }

  const enrichedPayload = { ...payload, purpose: 'job_application_verification' };
  const record = await callRecordService.createFromWebhook(enrichedPayload);

  if (record.executionId) {
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    const application = await JobApplication.findOne({ verificationCallExecutionId: record.executionId })
      .select('candidate job')
      .lean();
    if (application) {
      sendPostCallEmailAndNotification(record, application).catch((err) =>
        logger.error(`Post-call email error: ${err.message}`)
      );
    } else {
      logger.warn(`Candidate webhook: no JobApplication found for executionId=${record.executionId}`);
    }
  }

  res.status(httpStatus.OK).send({
    success: true,
    id: record._id?.toString(),
    executionId: record.executionId,
    message: 'Candidate verification webhook received and stored',
  });
});

export {
  initiateCall,
  initiateCandidateCall,
  getCallStatus,
  getCallRecords,
  receiveWebhook,
  receiveCandidateWebhook,
  syncMissingCallRecords,
  deleteCallRecord,
};

