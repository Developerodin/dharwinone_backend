import crypto from 'node:crypto';
import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone } from '../utils/phone.js';
import { runSerializedForBolnaAgent } from '../utils/bolnaAgentRunSerialized.js';
import { bolnaJobContextFromDoc } from '../utils/jobBolnaContext.js';
import { buildJobPostingVerificationPromptPackage } from './jobPostingVerificationPrompt.service.js';

/**
 * Patch job-posting Bolna agent prompt, then dial organisation phone from the Job document (not client-supplied).
 * @param {Object} p
 * @param {string} p.agentId - BOLNA_AGENT_ID
 * @param {Object} p.job - Mongoose job doc
 * @param {string} [p.contactLabel] - Shown in user_data (company / contact label; not an applicant name)
 * @param {string} [p.fromPhoneNumber]
 */
export async function initiateJobPostingVerificationCall({ agentId, job, contactLabel, fromPhoneNumber }) {
  const orgPhoneRaw = job.organisation?.phone;
  if (!orgPhoneRaw || !String(orgPhoneRaw).trim()) {
    return { success: false, error: 'Job organisation phone is missing. Add it to the job in ATS before calling.' };
  }

  const phone = normalizePhone(String(orgPhoneRaw).trim());
  if (!phone || !validatePhone(phone)) {
    return { success: false, error: 'Organisation phone on the job is not a valid number for outbound calling.' };
  }

  const orgName = job.organisation?.name || '';
  const label = (contactLabel && String(contactLabel).trim()) || orgName || 'Organisation contact';

  const { systemPrompt, userData: richUserData, openingGreeting } =
    buildJobPostingVerificationPromptPackage(job);
  const promptHash = crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12);
  const jobCtx = bolnaJobContextFromDoc(job);

  return runSerializedForBolnaAgent(agentId, async () => {
    const patchResult = await bolnaService.updateAgentPrompt(agentId, systemPrompt, {
      agentWelcomeMessage: openingGreeting,
    });
    if (!patchResult.success) {
      logger.error(
        `Bolna job-posting prompt patch failed (promptHash=${promptHash}): ${patchResult.error}`
      );
    } else {
      logger.info(`Bolna job-posting agent prompt updated (promptHash=${promptHash}) jobId=${job._id}`);
    }

    return bolnaService.initiateCall({
      phone,
      candidateName: label,
      agentId,
      fromPhoneNumber,
      ...jobCtx,
      userData: {
        ...richUserData,
        organisation: orgName,
        job_title: job.title,
        job_type: jobCtx.jobType,
        location: jobCtx.location,
        experience_level: jobCtx.experienceLevel,
        salary_range: jobCtx.salaryRange,
      },
    });
  });
}
