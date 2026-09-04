/**
 * Job Application Verification Call Scheduler
 * Automatically calls candidates after they apply to:
 * - Thank them for applying
 * - Verify their contact details
 * - Provide job information
 */

import JobApplication from '../models/jobApplication.model.js';
import User from '../models/user.model.js';
import logger from '../config/logger.js';
import bolnaService from './bolna.service.js';
import { normalizePhone, validatePhonePlausible, isPlaceholderPhone } from '../utils/phone.js';
import callRecordService from './callRecord.service.js';
import { initiateCandidateVerificationCall } from './bolnaCandidateVerification.service.js';

/**
 * Find applications that need verification calls
 * - Created in last 10 minutes
 * - No existing verification call
 * - Has valid phone number
 */
/**
 * How far back an application stays eligible for its verification call. This was 10
 * minutes, so a restart, a deploy, a Bolna error or an 11th application in one tick
 * dropped the candidate forever — it aged out before the next pass could reach it.
 */
const ELIGIBILITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** A claim older than this is treated as abandoned and may be retried. */
const CLAIM_RETRY_MS = 15 * 60 * 1000;

/** `$in: [null]` also matches absent fields, covering never-claimed in one branch. */
const unclaimedFilter = () => [
  { verificationCallInitiatedAt: { $in: [null] } },
  { verificationCallInitiatedAt: { $lt: new Date(Date.now() - CLAIM_RETRY_MS) } },
];

let inFlight = false;

async function findApplicationsNeedingCalls() {
  try {
    const eligibleSince = new Date(Date.now() - ELIGIBILITY_WINDOW_MS);

    const applications = await JobApplication.find({
      verificationCallExecutionId: { $in: [null, ''] },
      // Terminal failures are not retried: one first attempt plus up to seven 15-minute
      // claim retries inside the 2-hour window (8 dials max by design).
      verificationCallStatus: { $nin: ['failed'] },
      createdAt: { $gte: eligibleSince },
      $or: unclaimedFilter(),
    })
      // Oldest first, so a backlog drains instead of starving behind limit(10).
      .sort({ createdAt: 1 })
      .populate({
        path: 'candidate',
        select:
          'fullName email phoneNumber countryCode owner qualifications experiences skills visaType customVisaType address shortBio salaryRange',
      })
      .populate({
        path: 'job',
        select:
          'title organisation jobType location experienceLevel salaryRange jobOrigin jobDescription skillTags',
      })
      .limit(10)
      .lean();
    
    const filtered = [];
    for (const app of applications) {
      if (app.job?.jobOrigin === 'external') continue;
      let phone = app.candidate?.phoneNumber;
      let cc = app.candidate?.countryCode;
      // Candidate phone may be a placeholder from browseApply auto-create — fall back to User's phone.
      if (!phone || isPlaceholderPhone(phone)) {
        const ownerId = app.candidate?.owner?._id ?? app.candidate?.owner ?? app.appliedBy;
        if (ownerId) {
          const user = await User.findById(ownerId).select('phoneNumber countryCode').lean();
          if (user?.phoneNumber && !isPlaceholderPhone(user.phoneNumber)) {
            phone = user.phoneNumber;
            cc = user.countryCode || cc;
            app.candidate.phoneNumber = phone;
            app.candidate.countryCode = cc;
          }
        }
      }
      if (!phone || isPlaceholderPhone(phone)) continue;
      filtered.push(app);
    }
    return filtered;
  } catch (error) {
    logger.error(`Error finding applications needing calls: ${error.message}`);
    return [];
  }
}

/**
 * Initiate verification calls for new applications
 */
async function runApplicationVerificationCalls() {
  try {
    const applications = await findApplicationsNeedingCalls();
    
    if (applications.length === 0) {
      logger.debug('No new applications requiring verification calls');
      return;
    }
    
    logger.info(`Found ${applications.length} applications needing verification calls`);
    
    for (const application of applications) {
      try {
        const { candidate, job } = application;
        
        if (!candidate || !job) {
          logger.warn(`Skipping application ${application._id}: missing candidate or job data`);
          continue;
        }
        
        if (isPlaceholderPhone(candidate.phoneNumber)) {
          logger.warn(
            `Skipping application ${application._id}: candidate phone is a placeholder (${candidate.phoneNumber}).`
          );
          continue;
        }

        const phone = normalizePhone(candidate.phoneNumber, candidate.countryCode || '');

        if (!phone || !validatePhonePlausible(phone)) {
          logger.warn(
            `Skipping application ${application._id}: phone is not a valid callable number (${phone}). ` +
              'Fix candidate phone or Bolna will reject the call.'
          );
          continue;
        }
        
        // Claim before dialling. executionId was previously only written AFTER Bolna
        // returned, so a call that outlived the 2-minute tick was re-selected and the
        // candidate was rung twice. Whoever flips verificationCallInitiatedAt first owns
        // the application; everyone else skips it.
        const claimed = await JobApplication.findOneAndUpdate(
          {
            _id: application._id,
            verificationCallExecutionId: { $in: [null, ''] },
            $or: unclaimedFilter(),
          },
          { $set: { verificationCallInitiatedAt: new Date() } },
          { new: true, projection: { _id: 1 } }
        ).lean();
        if (!claimed) continue;

        logger.info(`Initiating verification call for application ${application._id} to ${phone}`);

        const config = (await import('../config/config.js')).default;

        const result = await initiateCandidateVerificationCall({
          agentId: config.bolna.candidateAgentId,
          formattedPhone: phone,
          candidate,
          job,
          application,
        });
        
        if (result.success && result.executionId) {
          // Update application with call details
          await JobApplication.updateOne(
            { _id: application._id },
            {
              $set: {
                verificationCallExecutionId: result.executionId,
                verificationCallInitiatedAt: new Date(),
                verificationCallStatus: 'pending',
              },
            }
          );
          
          // Create call record for tracking
          await callRecordService.createRecord({
            executionId: result.executionId,
            recipientPhone: phone,
            recipientName: candidate.fullName,
            recipientEmail: candidate.email,
            purpose: 'job_application_verification',
            relatedJobApplication: application._id,
            relatedJob: job._id,
            relatedCandidate: candidate._id,
            status: 'initiated',
          });
          
          logger.info(
            `✅ Verification call initiated for ${candidate.fullName} (${phone}) - ` +
            `Application: ${application._id}, Execution: ${result.executionId}`
          );
        } else {
          logger.warn(
            `❌ Verification call failed for application ${application._id}: ${result.error || 'unknown error'}`
          );
          
          // Mark as failed
          await JobApplication.updateOne(
            { _id: application._id },
            {
              $set: {
                verificationCallStatus: 'failed',
              },
            }
          );
        }
      } catch (appError) {
        logger.error(`Error processing application ${application._id}: ${appError.message}`);
      }
    }
  } catch (error) {
    logger.error(`Application verification call scheduler error: ${error.message}`);
  }
}

/**
 * Sync call records from Bolna to update application status
 */
function mapNormalizedStatusToApplicationVerification(normStatus) {
  const s = String(normStatus || 'unknown').toLowerCase();
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'error' || s === 'expired') return 'failed';
  if (s === 'no_answer' || s === 'busy') return 'no_answer';
  if (s === 'in_progress' || s === 'initiated' || s === 'ringing' || s === 'queued') return 'pending';
  return 'pending';
}

async function syncApplicationCallRecords() {
  try {
    const records = await callRecordService.findRecordsNeedingSync(25);

    for (const rec of records) {
      const executionId = rec.executionId;
      if (!executionId) continue;

      const result = await bolnaService.getExecutionDetails(executionId);
      if (!result.success || !result.details) continue;

      const details = result.details;

      // Execution expired in Bolna (404) — mark terminal so we stop polling.
      if (details.status === 'unknown' && details.error_message?.includes('not found')) {
        await callRecordService.updateFromExecutionDetails(executionId, details, {
          setCompletedAt: true,
          setErrorMessage: true,
        });
        await JobApplication.updateOne(
          { verificationCallExecutionId: executionId },
          { $set: { verificationCallStatus: 'failed' } }
        );
        continue;
      }

      const data = details.data || details.execution || {};
      const hadBolnaStatus =
        details.status != null ||
        details.smart_status != null ||
        data.status != null ||
        data.smart_status != null;

      const updated = await callRecordService.updateFromExecutionDetails(executionId, details, {
        setCompletedAt: true,
        setErrorMessage: true,
      });

      const norm = callRecordService.normalizePayload({
        ...details,
        id: details.id ?? details.execution_id ?? executionId,
      });

      if (updated?.transcript || updated?.recordingUrl) {
        logger.info(`Synced application call record ${executionId} with transcript/recording from Bolna`);
      } else if (hadBolnaStatus) {
        logger.debug(`Application call record ${executionId} Bolna status: ${norm.status}`);
      }

      if (hadBolnaStatus) {
        const appCallStatus = mapNormalizedStatusToApplicationVerification(norm.status);
        await JobApplication.updateOne(
          { verificationCallExecutionId: executionId },
          { $set: { verificationCallStatus: appCallStatus } }
        );
      }
    }

    logger.debug(`Application call records sync completed: checked ${records.length} record(s)`);
  } catch (error) {
    logger.error(`Application call record sync error: ${error.message}`);
  }
}

/**
 * Main scheduler run function
 */
async function run() {
  if (inFlight) {
    logger.info('[applicationVerificationCall] previous tick still running; skipping');
    return;
  }
  inFlight = true;
  try {
    logger.debug('Running application verification call scheduler...');
    await runApplicationVerificationCalls();
    await syncApplicationCallRecords();
  } finally {
    inFlight = false;
  }
}

/**
 * Start the scheduler
 * @param {number} intervalMinutes - How often to run (default: 2 minutes)
 * @returns {NodeJS.Timeout} Interval ID
 */
const startApplicationVerificationCallScheduler = (intervalMinutes = 2) => {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  // Run immediately on start
  run();
  
  // Then run on interval
  const id = setInterval(run, intervalMs);
  
  logger.info(
    `📞 Application verification call scheduler started (every ${intervalMinutes} min)`
  );
  
  return id;
};

const stopApplicationVerificationCallScheduler = (id) => {
  if (id) {
    clearInterval(id);
    logger.info('Application verification call scheduler stopped');
    return true;
  }
  return false;
};

export default {
  startApplicationVerificationCallScheduler,
  stopApplicationVerificationCallScheduler,
  runApplicationVerificationCalls,
  syncApplicationCallRecords,
  run,
};
