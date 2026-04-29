import crypto from 'node:crypto';
import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import { bolnaJobAndCandidateAgentsCollide } from '../utils/bolnaAgentConfig.js';
import { runSerializedForBolnaAgent } from '../utils/bolnaAgentRunSerialized.js';
import { getBolnaCandidateAgentSettingsForPrompt } from './bolnaCandidateAgentSettings.service.js';
import {
  buildCandidateAgentPrompt,
  buildCandidateVerificationPromptContext,
  resolveCandidateAgentGreeting,
} from './candidateVerificationPrompt.service.js';
import { getKbPromptContextForExternalAgent } from './kbQuery.service.js';

/**
 * Patch candidate agent system prompt (with DB overrides) then place call.
 * @param {Object} p
 * @param {string} p.agentId
 * @param {string} p.formattedPhone - E.164
 * @param {Object} p.candidate
 * @param {Object} p.job
 * @param {Object} [p.application]
 * @param {string} [p.jobTitleOverride]
 * @param {string} [p.companyNameOverride]
 * @param {Object} [p.initiateExtras] - passed to bolnaService.initiateCall (e.g. fromPhoneNumber)
 */
export async function initiateCandidateVerificationCall({
  agentId,
  formattedPhone,
  candidate,
  job,
  application,
  jobTitleOverride,
  companyNameOverride,
  initiateExtras = {},
}) {
  if (bolnaJobAndCandidateAgentsCollide()) {
    const errMsg =
      'Bolna is misconfigured: BOLNA_CANDIDATE_AGENT_ID must be a different agent than BOLNA_AGENT_ID. ' +
      'Applicant calls PATCH the agent system prompt; sharing the job-posting agent makes recruiter and applicant scripts conflict. ' +
      'Add a second agent in Bolna and set BOLNA_CANDIDATE_AGENT_ID in .env.';
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }

  const settings = await getBolnaCandidateAgentSettingsForPrompt();
  const promptContext = await buildCandidateVerificationPromptContext({
    candidate,
    job,
    application,
    formattedPhone,
    jobTitleOverride,
    companyNameOverride,
  });

  const openingGreeting = resolveCandidateAgentGreeting(promptContext, settings.greetingOverride);
  let extra = settings.extraSystemInstructions || '';
  try {
    const kbCtx = await getKbPromptContextForExternalAgent(agentId);
    if (kbCtx) {
      extra = extra ? `${extra}\n\n${kbCtx}` : kbCtx;
    }
  } catch (e) {
    logger.warn(`[KB] prompt context skipped: ${e.message}`);
  }
  const systemPrompt = buildCandidateAgentPrompt(promptContext, {
    openingGreeting,
    extraSystemInstructions: extra,
  });

  const promptHash = crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12);

  return runSerializedForBolnaAgent(agentId, async () => {
    const patchResult = await bolnaService.updateAgentPrompt(agentId, systemPrompt, {
      agentWelcomeMessage: openingGreeting,
    });
    if (!patchResult.success) {
      logger.error(
        `Bolna prompt patch failed before verification call (promptHash=${promptHash}): ${patchResult.error}`
      );
    } else {
      logger.info(`Bolna candidate agent prompt updated (promptHash=${promptHash})`);
    }

    // Pass confirmation + skill-matched opportunities context to Bolna userData.
    const userData = {
      candidate_name: promptContext.candidate_name,
      candidate_phone: promptContext.candidate_phone,
      candidate_email: promptContext.candidate_email,
      candidate_email_spoken: promptContext.candidate_email_spoken,
      candidate_location: promptContext.candidate_location,
      candidate_skills: promptContext.candidate_skills || '',
      job_title: promptContext.job_title,
      company_name: promptContext.company_name,
      application_date: promptContext.application_date,
      matched_jobs_count: promptContext.matched_jobs_count ?? 0,
      matched_jobs_spoken: promptContext.matched_jobs_spoken || '',
    };

    return bolnaService.initiateCall({
      phone: formattedPhone,
      candidateName: candidate.fullName,
      agentId,
      jobTitle: promptContext.job_title,
      organisation: promptContext.company_name,
      userData,
      ...initiateExtras,
    });
  });
}
