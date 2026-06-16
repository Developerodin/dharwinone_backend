import httpStatus from 'http-status';
import { Readable } from 'node:stream';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import bolnaService from '../services/bolna.service.js';
import { initiateCandidateVerificationCall } from '../services/bolnaCandidateVerification.service.js';
import { initiateJobPostingVerificationCall } from '../services/bolnaJobPostingVerification.service.js';
import callRecordService from '../services/callRecord.service.js';
import callSyncService from '../services/callSync.service.js';
import {
  resolveCallRecordingSources,
  headersForRecordingUrl,
  archiveCallRecordings,
  getArchivedPlaybackUrlByExecution,
  getArchivePresence,
} from '../services/callRecordingArchive.service.js';
import { ensureCandidateVerificationExtractions } from '../services/bolnaCandidateExtractionSetup.service.js';
import { getJobById } from '../services/job.service.js';
import Job from '../models/job.model.js';
import { isTerminal } from '../models/callRecord.model.js';
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
    // Seed via the single chokepoint — idempotent, emits socket, sets statusRank.
    await callSyncService.seedRecord({
      executionId: result.executionId,
      job: job._id,
      purpose: 'job_posting_verification',
      agentId: config.bolna.agentId,
      recipientPhone: job.organisation?.phone || body.phone || null,
      businessName: job.organisation?.name || null,
      createdBy: req.user?._id || req.user?.id || null,
      requestId: req.id || req.headers?.['x-request-id'] || null,
    });
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

  // Seed CallRecord via the single chokepoint — race-safe vs webhook arriving first.
  await callSyncService.seedRecord({
    executionId: result.executionId,
    candidate: candidateId,
    job: jobId,
    purpose: 'job_application_verification',
    agentId: candidateAgentId,
    recipientPhone: formattedPhone,
    businessName: candidate.fullName,
    createdBy: req.user?._id || req.user?.id || null,
    requestId: req.id || req.headers?.['x-request-id'] || null,
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

function maskSecret(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)} (len=${value.length})`;
}

const getBolnaDiagnostics = catchAsync(async (req, res) => {
  const { apiKey, apiBase } = bolnaService.getConfig();
  const agentId = config.bolna.agentId;
  const candidateAgentId = config.bolna.candidateAgentId;

  const checkAgent = async (aid) => {
    if (!aid) return { configured: false };
    if (!apiKey) return { configured: true, agentId: aid, error: 'BOLNA_API_KEY missing' };
    try {
      const r = await fetch(`${apiBase}/v2/agent/${aid}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await r.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
      return {
        configured: true,
        agentId: aid,
        status: r.status,
        exists: r.ok,
        bolnaMessage: body?.message || body?.error || body?.detail || (r.ok ? 'ok' : text?.slice(0, 200)),
      };
    } catch (err) {
      return { configured: true, agentId: aid, error: err.message };
    }
  };

  const [agentCheck, candidateAgentCheck] = await Promise.all([
    checkAgent(agentId),
    checkAgent(candidateAgentId),
  ]);

  res.status(httpStatus.OK).send({
    success: true,
    env: {
      apiBase,
      apiKeyMasked: maskSecret(apiKey),
      apiKeyPresent: Boolean(apiKey),
      fromPhoneNumber: config.bolna.fromPhoneNumber || null,
      agentIdSource: process.env.BOLNA_AGENT_ID ? 'env' : 'hardcoded-default',
      candidateAgentIdSource: process.env.BOLNA_CANDIDATE_AGENT_ID
        ? 'env'
        : process.env.BOLNA_AGENT_ID
          ? 'fallback-to-BOLNA_AGENT_ID'
          : 'hardcoded-default',
      sameAgentIds: agentId === candidateAgentId,
    },
    agent: agentCheck,
    candidateAgent: candidateAgentCheck,
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
  const verif = await callRecordService.backfillVerification(200);
  res.status(httpStatus.OK).send({
    success: true,
    backfilled: backfill.backfilled,
    synced: sync.synced,
    errors: backfill.errors + sync.errors,
    verificationBackfilled: verif.updated,
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

async function assertCanAccessCall(req, executionId) {
  const record = await callRecordService.getCallRecordScopeFields(executionId);
  if (!record) throw new ApiError(httpStatus.NOT_FOUND, 'Call record not found');
  const isAdmin = await userIsAdmin(req.user);
  const userId = req.user?.id || req.user?._id?.toString();
  const allowed = await callRecordService.userCanAccessCallRecord(record, { userId, isAdmin });
  if (!allowed) throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this call');
}

/** Stream a remote (auth-protected) audio URL back to the JWT-authed client inline. */
async function streamRemoteAudio(res, url, headers, fallbackType, filename) {
  const upstream = await fetch(url, { headers });
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(httpStatus.BAD_GATEWAY, `Upstream recording fetch failed (${upstream.status})`);
  }
  res.setHeader('Content-Type', upstream.headers.get('content-type') || fallbackType);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(upstream.body).pipe(res);
}

/**
 * POST /bolna/call-records/:executionId/refresh
 * Re-fetch execution from Bolna and merge extracted_data, transcript, recordings into CallRecord.
 */
const refreshCallRecord = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  await assertCanAccessCall(req, executionId);
  const exec = await bolnaService.getExecutionFull(executionId);
  if (!exec.success) {
    throw new ApiError(
      exec.notFound ? httpStatus.NOT_FOUND : httpStatus.BAD_GATEWAY,
      exec.error || 'Failed to fetch execution from Bolna'
    );
  }
  const record = await callRecordService.updateFromExecutionDetails(executionId, exec.details, {
    setCompletedAt: true,
    setErrorMessage: true,
  });
  if (!record) throw new ApiError(httpStatus.NOT_FOUND, 'Call record not found');
  res.status(httpStatus.OK).send({ success: true, record });
});

/**
 * POST /bolna/candidate-agent/setup-extractions
 * Create the seven Candidate Verification dispositions on the Bolna candidate agent (idempotent).
 */
const setupCandidateVerificationExtractions = catchAsync(async (req, res) => {
  const result = await ensureCandidateVerificationExtractions(req.body?.agentId);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Bolna disposition setup failed');
  }
  logger.info(
    `[Bolna] Candidate verification extractions ${result.alreadyConfigured ? 'already present' : 'created'} ` +
      `agent=${result.agentId} count=${result.createdCount ?? 0}`
  );
  res.status(httpStatus.OK).send({ success: true, ...result });
});

const getCallRecordingSources = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  await assertCanAccessCall(req, executionId);
  const { bolnaUrl, providerCallId, plivo, provider, execError } = await resolveCallRecordingSources(executionId);
  const base = `/v1/bolna/call-records/${encodeURIComponent(executionId)}/recordings`;
  // A saved S3 copy keeps a recording reviewable even after the live source expires.
  const archived = await getArchivePresence(executionId);

  res.status(httpStatus.OK).send({
    success: true,
    executionId,
    provider,
    recordings: {
      bolna:
        bolnaUrl || archived.bolna
          ? { available: true, channel: 'agent_only', streamUrl: `${base}/bolna`, archived: archived.bolna }
          : {
              available: false,
              reason: execError || 'no recording_url on call',
            },
      plivo:
        plivo.length || archived.plivo
          ? {
              available: true,
              channel: 'dual',
              durationMs: plivo[0]?.durationMs ?? null,
              streamUrl: `${base}/plivo`,
              archived: archived.plivo,
            }
          : {
              available: false,
              reason: providerCallId ? 'no recording found on Plivo' : 'no provider_call_id on call',
            },
    },
  });
});

/** GET /bolna/call-records/:executionId/recordings/bolna — agent-leg audio (Bolna). */
const streamBolnaRecording = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  await assertCanAccessCall(req, executionId);
  const { bolnaUrl } = await resolveCallRecordingSources(executionId);
  if (bolnaUrl) {
    // Ensure a durable S3 copy exists for future review (best-effort, non-blocking).
    archiveCallRecordings(executionId).catch(() => {});
    const contentType = String(bolnaUrl).toLowerCase().includes('plivo') ? 'audio/mpeg' : 'audio/wav';
    const ext = contentType === 'audio/mpeg' ? 'mp3' : 'wav';
    await streamRemoteAudio(res, bolnaUrl, headersForRecordingUrl(bolnaUrl), contentType, `${executionId}-agent.${ext}`);
    return;
  }
  // Live source gone — serve the archived S3 copy if we saved one.
  const archivedUrl = await getArchivedPlaybackUrlByExecution(executionId, 'bolna');
  if (archivedUrl) return res.redirect(archivedUrl);
  throw new ApiError(httpStatus.NOT_FOUND, 'No Bolna recording for this call');
});

/** GET /bolna/call-records/:executionId/recordings/plivo — full dual-channel audio (Plivo). */
const streamPlivoRecording = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  await assertCanAccessCall(req, executionId);
  const { plivo } = await resolveCallRecordingSources(executionId);
  if (plivo.length) {
    archiveCallRecordings(executionId).catch(() => {});
    const basic = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
    await streamRemoteAudio(
      res,
      plivo[0].recordingUrl,
      { Authorization: `Basic ${basic}` },
      'audio/mpeg',
      `${executionId}-full.mp3`
    );
    return;
  }
  const archivedUrl = await getArchivedPlaybackUrlByExecution(executionId, 'plivo');
  if (archivedUrl) return res.redirect(archivedUrl);
  throw new ApiError(httpStatus.NOT_FOUND, 'No Plivo recording for this call');
});

/**
 * Webhook handler — recruiter/job posting verification calls.
 * All state mutations route through callSyncService.applyEvent (idempotent,
 * monotonic, socket-emitting). Post-call email side-effect runs only on
 * terminal status, claimed via postCallFollowUpSent flag in CallRecord.
 */
const receiveWebhook = catchAsync(async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      error: 'Body must be a JSON object',
    });
  }

  const result = await callSyncService.applyEvent(payload, 'webhook', {
    requestId: req.id || req.headers?.['x-request-id'] || null,
  });
  const record = result.record;

  if (record?.executionId) {
    // Mirror Bolna + Plivo recordings to S3 for future review (best-effort, non-blocking).
    if (isTerminal(record.status)) {
      archiveCallRecordings(record.executionId).catch((err) =>
        logger.error(`Recording archive error (${record.executionId}): ${err.message}`)
      );
    }
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
    applied: result.applied,
    reason: result.reason,
    id: record?._id?.toString?.() || record?.id || null,
    executionId: record?.executionId || null,
    message: 'Webhook accepted',
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

  // Tag purpose so applyEvent's stub-create path categorizes correctly when
  // the webhook beats the seed.
  const enriched = { ...payload, purpose: payload.purpose || 'job_application_verification' };
  const result = await callSyncService.applyEvent(enriched, 'webhook_candidate', {
    requestId: req.id || req.headers?.['x-request-id'] || null,
  });
  const record = result.record;

  if (record?.executionId) {
    // Mirror Bolna + Plivo recordings to S3 for future review (best-effort, non-blocking).
    if (isTerminal(record.status)) {
      archiveCallRecordings(record.executionId).catch((err) =>
        logger.error(`Recording archive error (${record.executionId}): ${err.message}`)
      );
    }
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

    // Phase 1: candidate explicitly asked to withdraw → reflect on the application.
    if (record?.verification?.stillInterested === 'withdrew') {
      await JobApplication.updateOne(
        { verificationCallExecutionId: record.executionId },
        { $set: { verificationCallStatus: 'withdrawn' } }
      );
      logger.info(`[Bolna] Candidate withdrew via verification call execId=${record.executionId}`);
    }
  }

  res.status(httpStatus.OK).send({
    success: true,
    applied: result.applied,
    reason: result.reason,
    id: record?._id?.toString?.() || record?.id || null,
    executionId: record?.executionId || null,
    message: 'Candidate verification webhook accepted',
  });
});

export {
  initiateCall,
  initiateCandidateCall,
  getCallStatus,
  getCallRecords,
  refreshCallRecord,
  getCallRecordingSources,
  streamBolnaRecording,
  streamPlivoRecording,
  receiveWebhook,
  receiveCandidateWebhook,
  syncMissingCallRecords,
  setupCandidateVerificationExtractions,
  deleteCallRecord,
  getBolnaDiagnostics,
};

