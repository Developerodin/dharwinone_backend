import Job from '../models/job.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';
import bolnaService from './bolna.service.js';
import callRecordService from './callRecord.service.js';
import { initiateJobPostingVerificationCall } from './bolnaJobPostingVerification.service.js';

async function runJobVerificationCalls() {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const jobs = await Job.find({
      verificationCallExecutionId: { $in: [null, ''] },
      'organisation.phone': { $exists: true, $nin: [null, ''] },
      createdAt: { $gte: fiveMinutesAgo },
      jobOrigin: { $ne: 'external' },
    })
      .limit(10)
      .lean();

    for (const job of jobs) {
      if (!job.organisation?.phone) continue;
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
        await callRecordService.updateCallRecordByExecutionId(
          result.executionId,
          {
            purpose: 'job_posting_verification',
            job: job._id,
            status: 'initiated',
          },
          { upsert: true }
        );
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
    const records = await callRecordService.findRecordsNeedingSync(10);
    for (const rec of records) {
      const executionId = rec.executionId;
      if (!executionId) continue;
      const result = await bolnaService.getExecutionDetails(executionId);
      if (!result.success || !result.details) continue;
      const updated = await callRecordService.updateFromExecutionDetails(executionId, result.details);
      if (updated) {
        logger.info(`Synced call record ${executionId} with transcript/recording from Bolna`);
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

