import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import {
  bolnaJobAndCandidateAgentsCollide,
  ensureAgentPrompt,
  missingTemplateVars,
} from '../utils/bolnaAgentConfig.js';
import { getBolnaCandidateAgentSettingsForPrompt } from './bolnaCandidateAgentSettings.service.js';
import {
  buildCandidateAgentPromptTemplate,
  buildCandidateAgentTemplateVars,
  buildCandidateVerificationPromptContext,
  resolveCandidateAgentGreeting,
} from './candidateVerificationPrompt.service.js';
import { getKbPromptContextForExternalAgent } from './kbQuery.service.js';

/**
 * PATCH the STATIC prompt template onto the candidate agent, then place the call
 * with every per-call value travelling in `user_data`.
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

  let extra = settings.extraSystemInstructions || '';
  try {
    const kbCtx = await getKbPromptContextForExternalAgent(agentId);
    if (kbCtx) {
      extra = extra ? `${extra}\n\n${kbCtx}` : kbCtx;
    }
  } catch (e) {
    logger.warn(`[KB] prompt context skipped: ${e.message}`);
  }

  // The PATCHed prompt is SHARED, PERMANENT agent state; `user_data` travels with
  // the call. So the prompt must stay static and every per-call value must ride in
  // user_data. Baking the candidate's name into the prompt made the agent greet
  // whichever candidate was PATCHed last — see the 2026-09-03 calls that spoke a
  // previous candidate's name while user_data held the correct one.
  const systemPrompt = buildCandidateAgentPromptTemplate();
  const templateVars = buildCandidateAgentTemplateVars(promptContext, {
    greetingOverride: settings.greetingOverride,
    extraSystemInstructions: extra,
  });

  // additional_instructions is blank whenever no admin extras and no KB context exist,
  // which is the normal case — everything else rendering empty is a bug.
  const missing = missingTemplateVars(systemPrompt, templateVars, {
    allowEmpty: ['additional_instructions'],
  });
  if (missing.length) {
    const errMsg = `Bolna prompt template has unsupplied placeholders: ${missing.join(', ')}`;
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Welcome message keeps its {placeholders} — it is shared state too, and Bolna
  // fills it per call from the same user_data.
  const welcomeMessage = resolveCandidateAgentGreeting(promptContext, settings.greetingOverride, {
    raw: true,
  });

  // Identical bytes on every call, so concurrent callers cannot corrupt each other and
  // no cross-process lock is needed. ensureAgentPrompt skips the PATCH entirely once the
  // agent already holds this prompt, and never blocks the dial if the sync fails.
  const sync = await ensureAgentPrompt({ agentId, systemPrompt, welcomeMessage });
  if (sync.fatal) {
    // Only when this process has never landed the prompt — the agent could still hold a
    // previous candidate's baked prompt, so dialling would call the right person and read
    // the wrong data. A later call retries the PATCH.
    return { success: false, error: `Bolna agent could not be prepared before the call: ${sync.error}` };
  }

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
    // last: these carry the template's own empty-value fallbacks (e.g.
    // company_name -> 'our company') and must not be overwritten by a blank ctx field.
    ...templateVars,
  };

  return bolnaService.initiateCall({
    phone: formattedPhone,
    // Sanitised, not the raw doc field: initiateCall copies this into BOTH `name` and
    // `candidate_name` on user_data, and providers commonly bind a generic `name` key to
    // the assistant's own identity. promptContext.candidate_name has already been through
    // promptSafe(); passing candidate.fullName here would put the raw value back.
    candidateName: promptContext.candidate_name,
    agentId,
    jobTitle: promptContext.job_title,
    organisation: promptContext.company_name,
    userData,
    ...initiateExtras,
  });
}
