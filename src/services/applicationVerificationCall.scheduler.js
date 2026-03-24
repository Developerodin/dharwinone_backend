/**
 * Job Application Verification Call Scheduler
 * Automatically calls candidates after they apply to:
 * - Thank them for applying
 * - Verify their contact details
 * - Provide job information
 */

import JobApplication from '../models/jobApplication.model.js';
import logger from '../config/logger.js';
import bolnaService from './bolna.service.js';
import callRecordService from './callRecord.service.js';
import { initiateCandidateVerificationCall } from './bolnaCandidateVerification.service.js';

/**
 * Find applications that need verification calls
 * - Created in last 10 minutes
 * - No existing verification call
 * - Has valid phone number
 */
async function findApplicationsNeedingCalls() {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    
    const applications = await JobApplication.find({
      verificationCallExecutionId: { $in: [null, ''] },
      createdAt: { $gte: tenMinutesAgo },
    })
      .populate({
        path: 'candidate',
        select:
          'fullName email phoneNumber countryCode qualifications experiences skills visaType customVisaType address shortBio salaryRange',
      })
      .populate({
        path: 'job',
        select:
          'title organisation jobType location experienceLevel salaryRange jobOrigin jobDescription skillTags',
      })
      .limit(10)
      .lean();
    
    // Filter to only those with valid phone numbers; skip applications to external mirrored jobs
    return applications.filter((app) => {
      if (app.job?.jobOrigin === 'external') return false;
      const phone = app.candidate?.phoneNumber;
      const countryCode = app.candidate?.countryCode;
      return phone && countryCode;
    });
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
        
        // Format phone number (E.164 format)
        const countryCode = candidate.countryCode || 'US';
        let phone = candidate.phoneNumber?.replace(/\D/g, '') || '';
        
        // Add country code if not present
        if (!phone.startsWith('+')) {
          const countryPrefix = countryCode === 'IN' ? '+91' : 
                               countryCode === 'US' ? '+1' : 
                               countryCode === 'GB' ? '+44' : 
                               countryCode === 'AU' ? '+61' : '+1';
          phone = `${countryPrefix}${phone}`;
        }
        
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
  if (s === 'failed' || s === 'error') return 'failed';
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
  logger.debug('Running application verification call scheduler...');
  await runApplicationVerificationCalls();
  await syncApplicationCallRecords();
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

export default {
  startApplicationVerificationCallScheduler,
  runApplicationVerificationCalls,
  syncApplicationCallRecords,
  run,
};
