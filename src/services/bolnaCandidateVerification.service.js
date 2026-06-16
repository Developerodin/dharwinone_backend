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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull every `system_prompt` string out of a Bolna agent GET response (it is nested). */
function extractSystemPrompts(agent) {
  const out = [];
  try {
    JSON.stringify(agent, (key, value) => {
      if (key === 'system_prompt' && typeof value === 'string') out.push(value);
      return value;
    });
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * PATCH the fully-rendered candidate prompt onto the shared agent, then GET the
 * agent back and confirm the new prompt is actually live BEFORE we dial.
 *
 * Why this exists: Bolna renders/caches the system prompt, so a call placed
 * immediately after a PATCH can run against a STALE prompt — this is what made
 * the agent greet a previous candidate (e.g. "Test Name") even though the call's
 * user_data was correct. The unique per-call `renderToken` is baked into the
 * prompt; we poll the agent until that exact token is the stored prompt, which
 * proves THIS candidate's prompt is the live one (and also busts Bolna's
 * render cache, since the prompt content now differs on every call).
 *
 * Returns { success } — the caller MUST abort the call when this is false.
 */
async function patchAndVerifyAgentPrompt(agentId, systemPrompt, welcomeMessage, renderToken) {
  const patch = await bolnaService.updateAgentPrompt(agentId, systemPrompt, {
    agentWelcomeMessage: welcomeMessage,
  });
  if (!patch.success) {
    logger.error(`Bolna candidate prompt PATCH failed (token=${renderToken}): ${patch.error}`);
    return { success: false, error: patch.error };
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const got = await bolnaService.getAgent(agentId);
    if (got.success && extractSystemPrompts(got.agent).some((p) => p.includes(renderToken))) {
      if (attempt > 1) {
        logger.info(`Bolna candidate prompt verified live after ${attempt} attempts (token=${renderToken})`);
      }
      return { success: true };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(400);
  }

  logger.error(
    `Bolna candidate prompt did NOT go live within ${MAX_ATTEMPTS} attempts (token=${renderToken}). ` +
      'Aborting call to avoid greeting the wrong candidate.'
  );
  return { success: false, error: 'patched prompt did not become live in time' };
}

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

  // Fully RESOLVED prompt — the candidate's name/job/etc. are baked directly into
  // the prompt text, NOT left as {variables}. Bolna's per-call variable
  // substitution proved unreliable for the system prompt: it served a cached
  // render from a previous candidate (spoke "Test Name" while user_data was
  // correct). Baking + a unique render token + verify-before-dial removes that
  // entire failure mode.
  const renderToken = `render-${crypto.randomUUID()}`;
  const systemPrompt = `${buildCandidateAgentPrompt(promptContext, {
    openingGreeting,
    extraSystemInstructions: extra,
  })}\n\n<!-- ${renderToken} -->`;

  return runSerializedForBolnaAgent(agentId, async () => {
    const prepared = await patchAndVerifyAgentPrompt(
      agentId,
      systemPrompt,
      openingGreeting,
      renderToken
    );
    if (!prepared.success) {
      // Do NOT place the call on an unverified/stale prompt — this was the bug.
      return {
        success: false,
        error: `Bolna agent could not be prepared before the call: ${prepared.error}`,
      };
    }

    // Prompt is fully baked, so user_data is now only for Bolna extraction /
    // disposition / analytics — not for prompt substitution.
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
