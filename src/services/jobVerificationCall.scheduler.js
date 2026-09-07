import Job from '../models/job.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';
import bolnaService from './bolna.service.js';
import callRecordService from './callRecord.service.js';
import { normalizePhone } from '../utils/phone.js';
import { initiateJobPostingVerificationCall } from './bolnaJobPostingVerification.service.js';

/**
 * How far back a job stays eligible for its verification call. This was 5 minutes, which
 * meant a restart, a deploy, a Bolna error or an 11th job in one tick dropped the job
 * forever — it aged out before the next pass could reach it. Two hours gives the retry
 * below room to work while never cold-calling an employer about a stale posting.
 */
const ELIGIBILITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** A claim older than this is treated as abandoned and may be retried. */
const CLAIM_RETRY_MS = 15 * 60 * 1000;

async function runJobVerificationCalls() {
  try {
    const now = Date.now();
    const eligibleSince = new Date(now - ELIGIBILITY_WINDOW_MS);
    const claimExpiredBefore = new Date(now - CLAIM_RETRY_MS);
    // `$in: [null]` also matches documents where the field is absent, so this covers the
    // never-called and the never-claimed cases without a second `$or` branch.
    const unclaimed = [
      { verificationCallInitiatedAt: { $in: [null] } },
      { verificationCallInitiatedAt: { $lt: claimExpiredBefore } },
    ];

    const jobs = await Job.find({
      verificationCallExecutionId: { $in: [null, ''] },
      'organisation.phone': { $exists: true, $nin: [null, ''] },
      createdAt: { $gte: eligibleSince },
      jobOrigin: { $ne: 'external' },
      $or: unclaimed,
    })
      // Oldest first: with limit(10) and no sort, a backlog could return the same page
      // every tick and starve everything behind it.
      .sort({ createdAt: 1 })
      .limit(10)
      .lean();

    for (const job of jobs) {
      if (!job.organisation?.phone) continue;

      // Claim before dialling. The executionId was previously only written AFTER Bolna
      // returned, so a call that outlived the 60s tick was re-selected and the employer
      // was dialled twice. This findOneAndUpdate is atomic: whoever flips
      // verificationCallInitiatedAt first owns the job, everyone else moves on.
      const claimed = await Job.findOneAndUpdate(
        {
          _id: job._id,
          verificationCallExecutionId: { $in: [null, ''] },
          $or: unclaimed,
        },
        { $set: { verificationCallInitiatedAt: new Date() } },
        { new: true, projection: { _id: 1 } }
      ).lean();
      if (!claimed) continue;

      const rawPhone = String(job.organisation.phone).trim();
      const phone = normalizePhone(rawPhone) || rawPhone;
      const contactLabel = job.organisation?.name || job.title || 'Organisation contact';
      const result = await initiateJobPostingVerificationCall({
        agentId: config.bolna.agentId,
        job,
        contactLabel,
      });
      if (result.success && result.executionId) {
        await Job.updateOne(
          { _id: job._id },
          {
            $set: {
              verificationCallExecutionId: result.executionId,
              verificationCallInitiatedAt: new Date(),
            },
          }
        );
        await callRecordService.createRecord({
          executionId: result.executionId,
          recipientPhone: phone,
          recipientName: job.organisation?.name || job.title || 'Organisation',
          purpose: 'job_posting_verification',
          relatedJob: job._id,
          status: 'initiated',
        });
        logger.info(`Job verification call initiated for job ${job._id}, executionId ${result.executionId}`);
      } else {
        logger.warn(`Job verification call failed for job ${job._id}: ${result.error || 'unknown'}`);
      }
    }
  } catch (e) {
    logger.error(`Job verification call scheduler (initiate): ${e.message}`);
  }
}

async function syncCallRecordsFromBolna() {
  try {
    // Only sync records that belong to job-posting verification calls.
    // Candidate call records are synced by the application verification scheduler.
    const records = await callRecordService.findRecordsNeedingSync(10);
    const jobRecords = records.filter(
      (r) => !r.purpose || r.purpose.toLowerCase().includes('job_posting_verification') || r.purpose.toLowerCase().includes('job_verification')
    );

    for (const rec of jobRecords) {
      const executionId = rec.executionId;
      if (!executionId) continue;
      const result = await bolnaService.getExecutionDetails(executionId);
      if (!result.success || !result.details) continue;

      const details = result.details;

      // Execution expired in Bolna (404) — mark terminal so we stop polling.
      if (details.status === 'unknown' && details.error_message?.includes('not found')) {
        await callRecordService.updateCallRecordByExecutionId(executionId, {
          status: 'expired',
          errorMessage: details.error_message,
        });
        continue;
      }

      const updated = await callRecordService.updateFromExecutionDetails(executionId, details, {
        setCompletedAt: true,
        setErrorMessage: true,
      });
      if (updated?.transcript || updated?.recordingUrl) {
        logger.info(`Synced job call record ${executionId} with transcript/recording from Bolna`);
      }
    }
  } catch (e) {
    logger.error(`Job verification call scheduler (sync records): ${e.message}`);
  }
}

async function run() {
  await runJobVerificationCalls();
  await syncCallRecordsFromBolna();
}

const startJobVerificationCallScheduler = (intervalMinutes = 1) => {
  const intervalMs = intervalMinutes * 60 * 1000;
  run();
  const id = setInterval(run, intervalMs);
  logger.info(`Job verification call scheduler started (every ${intervalMinutes} min)`);
  return id;
};

const stopJobVerificationCallScheduler = (id) => {
  if (id) {
    clearInterval(id);
    logger.info('Job verification call scheduler stopped');
    return true;
  }
  return false;
};

export {
  runJobVerificationCalls,
  syncCallRecordsFromBolna,
  startJobVerificationCallScheduler,
  stopJobVerificationCallScheduler,
};

