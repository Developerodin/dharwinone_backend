import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import {
  assertQ2LineMatchesJobTitle,
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
  renderPromptTemplateWithVars,
  resolveCandidateAgentGreeting,
} from './candidateVerificationPrompt.service.js';
import { getKbPromptContextForExternalAgent } from './kbQuery.service.js';

function bolnaEntityId(doc) {
  if (!doc) return '';
  return String(doc._id ?? doc.id ?? '').trim();
}

/**
 * Render and PATCH the candidate prompt for THIS call, then place the call with
 * matching per-call values in `user_data`.
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

  const systemPromptTemplate = buildCandidateAgentPromptTemplate();
  const templateVars = buildCandidateAgentTemplateVars(promptContext, {
    greetingOverride: settings.greetingOverride,
    extraSystemInstructions: extra,
  });

  // additional_instructions is blank whenever no admin extras and no KB context exist,
  // which is the normal case — everything else rendering empty is a bug.
  const missing = missingTemplateVars(systemPromptTemplate, templateVars, {
    allowEmpty: ['candidate_verification_additional_instructions'],
  });
  if (missing.length) {
    const errMsg = `Bolna prompt template has unsupplied placeholders: ${missing.join(', ')}`;
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }

  const welcomeTemplate = resolveCandidateAgentGreeting(promptContext, settings.greetingOverride, {
    raw: true,
  });

  const welcomeMissing = missingTemplateVars(welcomeTemplate, templateVars, {
    allowEmpty: ['candidate_verification_additional_instructions'],
  });
  if (welcomeMissing.length) {
    const errMsg = `Bolna welcome template has unsupplied placeholders: ${welcomeMissing.join(', ')}`;
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }
  const systemPrompt = renderPromptTemplateWithVars(systemPromptTemplate, templateVars);
  const welcomeMessage = renderPromptTemplateWithVars(welcomeTemplate, templateVars);

  const userData = {
    candidate_verification_applicant_name: promptContext.candidate_name,
    candidate_verification_job_title: promptContext.job_title,
    candidate_verification_company_name: promptContext.company_name,
    candidate_phone: promptContext.candidate_phone,
    candidate_email: promptContext.candidate_email,
    candidate_email_spoken: promptContext.candidate_email_spoken,
    candidate_location: promptContext.candidate_location,
    candidate_skills: promptContext.candidate_skills || '',
    application_date: promptContext.application_date,
    matched_jobs_count: promptContext.matched_jobs_count ?? 0,
    matched_jobs_spoken: promptContext.matched_jobs_spoken || '',
    // Legacy Bolna keys (initiateCall + remote disposition specs may still bind these).
    // Canonical prompt/extraction fields use candidate_verification_* above and in templateVars.
    candidate_name: promptContext.candidate_name,
    job_title: promptContext.job_title,
    company_name: promptContext.company_name,
    // last: templateVars carry empty-value fallbacks (e.g. company -> 'our company')
    // and must not be overwritten by a blank ctx field.
    ...templateVars,
  };

  const payloadCheck = assertUserDataWithinLimit(userData);
  if (!payloadCheck.ok) {
    logger.error(`[Bolna] ${payloadCheck.error}`);
    return { success: false, error: payloadCheck.error };
  }

  const dialLogContext = {
    candidateId: bolnaEntityId(candidate),
    applicationId: bolnaEntityId(application),
    jobId: bolnaEntityId(job),
    canonicalJobTitle: promptContext.job_title,
    agentId,
    userDataBytes: payloadCheck.bytes,
  };

  const jobTitleCheck = assertQ2LineMatchesJobTitle({
    canonicalJobTitle: promptContext.job_title,
    q2Line: templateVars.candidate_verification_q2_line,
    userDataJobTitle: userData.candidate_verification_job_title,
  });
  if (!jobTitleCheck.ok) {
    logger.error(`[Bolna] ${jobTitleCheck.error}`, dialLogContext);
    return { success: false, error: jobTitleCheck.error };
  }

  logger.info('[Bolna] candidate verification pre-dial checks passed', dialLogContext);

  const prepared = await prepareAgentPromptForCall(
    bolnaService,
    agentId,
    systemPrompt,
    welcomeMessage,
    {},
    async ({ renderToken }) => {
      logger.info('[Bolna] candidate verification dialing', {
        ...dialLogContext,
        promptToken: renderToken,
      });
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

  const executionId = prepared.dialResult?.executionId;
  logger.info('[Bolna] candidate verification dial completed', {
    ...dialLogContext,
    promptToken: prepared.renderToken,
    executionId: executionId ? String(executionId) : undefined,
  });

  return prepared.dialResult;
}
