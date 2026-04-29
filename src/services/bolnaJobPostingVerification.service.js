import crypto from 'node:crypto';
import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone } from '../utils/phone.js';
import { runSerializedForBolnaAgent } from '../utils/bolnaAgentRunSerialized.js';
import { bolnaJobContextFromDoc } from '../utils/jobBolnaContext.js';
import { buildJobPostingVerificationPromptPackage } from './jobPostingVerificationPrompt.service.js';

/**
 * Patch the job-posting Bolna agent prompt, then dial the organisation phone
 * stored on the Job document.
 *
 * @param {Object} p
 * @param {string} p.agentId          - BOLNA_AGENT_ID (job-posting agent)
 * @param {Object} p.job              - Mongoose job doc or lean object
 * @param {string} [p.contactLabel]   - Display label for call record (org name / contact)
 * @param {string} [p.fromPhoneNumber] - Override outbound caller ID
 */
export async function initiateJobPostingVerificationCall({ agentId, job, contactLabel, fromPhoneNumber }) {
  // ── Phone validation ──────────────────────────────────────────────────────
  const orgPhoneRaw = job.organisation?.phone;
  if (!orgPhoneRaw || !String(orgPhoneRaw).trim()) {
    return {
      success: false,
      error: 'Job organisation phone is missing. Add it to the job in ATS before calling.',
    };
  }

  const phone = normalizePhone(String(orgPhoneRaw).trim());
  if (!phone || !validatePhone(phone)) {
    return {
      success: false,
      error: 'Organisation phone on the job is not a valid E.164 number for outbound calling.',
    };
  }

  // ── Context & prompt ──────────────────────────────────────────────────────
  const orgName = job.organisation?.name || '';
  const label = (contactLabel && String(contactLabel).trim()) || orgName || 'Organisation contact';

  const { systemPrompt, userData: richUserData, openingGreeting } =
    buildJobPostingVerificationPromptPackage(job);

  const promptHash = crypto
    .createHash('sha256')
    .update(systemPrompt)
    .digest('hex')
    .slice(0, 12);

  const jobCtx = bolnaJobContextFromDoc(job);

  return runSerializedForBolnaAgent(agentId, async () => {
    // PATCH agent system prompt + welcome message
    const patchResult = await bolnaService.updateAgentPrompt(agentId, systemPrompt, {
      agentWelcomeMessage: openingGreeting,
    });

    if (!patchResult.success) {
      logger.error(
        `[Bolna] Job-posting prompt patch failed (promptHash=${promptHash}): ${patchResult.error}`
      );
    } else {
      logger.info(
        `[Bolna] Job-posting agent prompt updated (promptHash=${promptHash}) jobId=${job._id}`
      );
    }

    // ── Build clean userData — no camelCase key bleed, no duplicates ────────
    // Do NOT set generic Bolna keys like `organisation` for this flow: providers often bind
    // `organisation` / `name` to assistant identity and the employer must stay third-party only.
    const userData = {
      ...richUserData,
      platform_name: 'Dharwin',
      assistant_identity:
        'You are the Dharwin platform automated listing-verification assistant. You do not work for the employer below.',
      listing_employer_name: orgName,
      contact_label: label,
      job_title: job.title || '',
      job_type: jobCtx.jobType || '',
      job_location: jobCtx.location || '',
      experience_level: jobCtx.experienceLevel || '',
      salary_range: jobCtx.salaryRange || '',
    };

    return bolnaService.initiateCall({
      phone,
      candidateName: label,   // Bolna uses this as the recipient display name
      agentId,
      fromPhoneNumber,
      userData,
    });
  });
}
