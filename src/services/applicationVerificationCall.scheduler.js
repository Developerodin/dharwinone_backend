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
import { numberToWords, currencyToWords } from '../utils/numberToWords.js';

/**
 * Format job context for Bolna agent
 */
function jobContextFromDocs(application, candidate, job) {
  if (!job || !candidate) return {};
  
  const orgName = job.organisation?.name || job.organisation || 'the company';
  let salaryRange = '';
  
  if (job.salaryRange) {
    const { min, max, currency } = job.salaryRange;
    const curr = currencyToWords(currency);
    if (min != null && max != null) {
      salaryRange = `${numberToWords(min)} to ${numberToWords(max)} ${curr}`;
    } else if (min != null) {
      salaryRange = `From ${numberToWords(min)} ${curr}`;
    } else if (max != null) {
      salaryRange = `Up to ${numberToWords(max)} ${curr}`;
    }
  }
  
  return {
    candidateName: candidate.fullName || 'there',
    candidate_name: candidate.fullName || 'there',
    jobTitle: job.title,
    job_title: job.title,
    organisation: orgName,
    company_name: orgName,
    jobType: job.jobType,
    job_type: job.jobType,
    location: job.location || 'not specified',
    experienceLevel: job.experienceLevel || 'not specified',
    experience_level: job.experienceLevel || 'not specified',
    salaryRange: salaryRange || 'to be discussed',
    salary_range: salaryRange || 'to be discussed',
    applicationDate: application.createdAt ? new Date(application.createdAt).toLocaleDateString() : 'today',
    candidateEmail: candidate.email,
    candidate_email: candidate.email,
  };
}

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
        select: 'fullName email phoneNumber countryCode',
      })
      .populate({
        path: 'job',
        select: 'title organisation jobType location experienceLevel salaryRange',
      })
      .limit(10)
      .lean();
    
    // Filter to only those with valid phone numbers
    return applications.filter((app) => {
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
        
        // Prepare context for Bolna agent
        const context = jobContextFromDocs(application, candidate, job);
        
        logger.info(`Initiating verification call for application ${application._id} to ${phone}`);
        
        // Use candidate agent ID for verification calls
        const config = (await import('../config/config.js')).default;
        
        const result = await bolnaService.initiateCall({
          phone,
          agentId: config.bolna.candidateAgentId, // Use candidate agent ID
          ...context,
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
async function syncApplicationCallRecords() {
  try {
    const records = await callRecordService.findRecordsNeedingSync(10);
    
    for (const rec of records) {
      const executionId = rec.executionId;
      if (!executionId) continue;
      
      const result = await bolnaService.getExecutionDetails(executionId);
      if (!result.success || !result.details) continue;
      
      const updated = await callRecordService.updateFromExecutionDetails(executionId, result.details);
      
      if (updated) {
        logger.info(`Synced application call record ${executionId} with transcript/recording from Bolna`);
        
        // Update application status based on call result
        const callStatus = result.details.status || 'unknown';
        let appCallStatus = 'pending';
        
        if (callStatus === 'completed') {
          appCallStatus = 'completed';
        } else if (callStatus === 'failed' || callStatus === 'error') {
          appCallStatus = 'failed';
        } else if (callStatus === 'no_answer' || callStatus === 'busy') {
          appCallStatus = 'no_answer';
        }
        
        // Update the application
        await JobApplication.updateOne(
          { verificationCallExecutionId: executionId },
          { $set: { verificationCallStatus: appCallStatus } }
        );
      }
    }
    
    logger.debug(`Application call records sync completed: ${records.length} executions synced`);
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
