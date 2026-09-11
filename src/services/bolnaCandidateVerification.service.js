import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import {
  assertUserDataWithinLimit,
  bolnaJobAndCandidateAgentsCollide,
  missingTemplateVars,
} from '../utils/bolnaAgentConfig.js';
import { prepareAgentPromptForCall } from '../utils/bolnaAgentTemplateSync.js';
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

  // The template is static and per-call data rides in user_data, but that alone is not
  // enough: Bolna caches the RESOLVED prompt per agent, keyed on prompt content, so
  // byte-identical bytes get a byte-identical cache hit and the agent keeps reading out
  // whoever it resolved for first. ensureAgentPrompt appends a unique token per call to
  // defeat that, and polls until the agent hands the token back.
  const welcomeMissing = missingTemplateVars(welcomeMessage, templateVars, {
    allowEmpty: ['additional_instructions'],
  });
  if (welcomeMissing.length) {
    const errMsg = `Bolna welcome template has unsupplied placeholders: ${welcomeMissing.join(', ')}`;
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
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

  const payloadCheck = assertUserDataWithinLimit(userData);
  if (!payloadCheck.ok) {
    logger.error(`[Bolna] ${payloadCheck.error}`);
    return { success: false, error: payloadCheck.error };
  }

  const prepared = await prepareAgentPromptForCall(
    bolnaService,
    agentId,
    systemPrompt,
    welcomeMessage,
    {},
    async ({ renderToken }) => {
      logger.info(
        `[Bolna] candidate call agent=${agentId} promptToken=${renderToken} userDataBytes=${payloadCheck.bytes}`
      );
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
  );
  if (!prepared.ok) {
    // Never dial on an unverified prompt: the agent may still be resolving a previous
    // candidate, so the call would reach the right person and read out the wrong data.
    return { success: false, error: `Bolna agent could not be prepared before the call: ${prepared.error}` };
  }

  return prepared.dialResult;
}
