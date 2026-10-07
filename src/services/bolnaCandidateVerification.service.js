import crypto from 'node:crypto';
import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import {
  assertQ2LineMatchesJobTitle,
  assertUserDataWithinLimit,
  bolnaJobAndCandidateAgentsCollide,
  missingTemplateVars,
} from '../utils/bolnaAgentConfig.js';
import { getBolnaCandidateAgentSettingsForPrompt } from './bolnaCandidateAgentSettings.service.js';
import {
  buildCandidateAgentPromptTemplate,
  buildCandidateAgentTemplateVars,
  buildCandidateVerificationPromptContext,
  renderPromptTemplateWithVars,
  resolveCandidateAgentGreeting,
} from './candidateVerificationPrompt.service.js';
import { getKbPromptContextForExternalAgent } from './kbQuery.service.js';
import { buildSlotOffer } from './interviewSlot.service.js';
import {
  buildCandidateToolsPutBody,
  ensureCandidateInterviewTools,
  templateCanBeCloned,
} from './bolnaCandidateToolsSetup.service.js';
import { registerOwnedCloneAgent, unregisterOwnedCloneAgent } from './bolnaOwnedAgents.js';

function bolnaEntityId(doc) {
  if (!doc) return '';
  return String(doc._id ?? doc.id ?? '').trim();
}

/**
 * Prompt block for one baked offer. Each line is the spoken time plus the slot_id
 * hold_interview_slot must send. No colon: the voice rules forbid them in speech.
 * Returns '' when there is nothing safe to read, so the caller keeps the email path.
 */
function formatBakedSlotOptions(offer, tzSpoken) {
  const slots = Array.isArray(offer?.slots) ? offer.slots : [];
  const lines = [];
  for (const slot of slots) {
    const spoken = slot?.spoken != null ? String(slot.spoken).trim() : '';
    const slotId = slot?.slot_id != null ? String(slot.slot_id).trim() : '';
    if (!spoken || !slotId) continue;
    lines.push(`option ${lines.length + 1}, ${spoken}. slot_id ${slotId}`);
  }
  if (!offer?.ok || !lines.length) return '';
  const zone = String(tzSpoken || 'the guessed time zone').trim();
  return [`These listed times are in the guessed time zone, ${zone}.`, ...lines].join('\n');
}

/**
 * PATCH the static candidate prompt template, then place the call with this
 * call's name/title/question lines in `user_data`.
 * @param {Object} p
 * @param {string} p.agentId
 * @param {string} p.formattedPhone - E.164
 * @param {Object} p.candidate
 * @param {Object} p.job
 * @param {Object} [p.application]
 * @param {string} [p.jobTitleOverride]
 * @param {Object} [p.initiateExtras] - passed to bolnaService.initiateCall (e.g. fromPhoneNumber)
 */
export async function initiateCandidateVerificationCall({
  agentId,
  formattedPhone,
  candidate,
  job,
  application,
  jobTitleOverride,
  initiateExtras = {},
}) {
  const resolvedAgentId = String(agentId || '').trim();
  if (!resolvedAgentId) {
    return { success: false, error: 'BOLNA_CANDIDATE_AGENT_ID is not configured.' };
  }
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

  const schedulingEnabled = promptContext.interview_scheduling_enabled === 'yes';
  // Times are filled in under the prompt lock, and only after tool setup persists.
  // Until then the placeholder is the email-a-link line, which is also what we PATCH
  // when setup throws, the agent GET fails, or the PUT read-back does not show the tools.
  const systemPromptTemplate = buildCandidateAgentPromptTemplate();
  const templateVars = buildCandidateAgentTemplateVars(promptContext, {
    greetingOverride: settings.greetingOverride,
    extraSystemInstructions: extra,
  });

  // additional_instructions is blank whenever no admin extras and no KB context exist,
  // which is the normal case ÔÇö everything else rendering empty is a bug.
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
    // AI interview scheduling (Bolna custom functions bind %(application_id)s from here).
    application_id: promptContext.application_id,
    candidate_timezone: promptContext.candidate_timezone,
    candidate_timezone_spoken: promptContext.candidate_timezone_spoken,
    interview_scheduling_enabled: promptContext.interview_scheduling_enabled,
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
    agentId: resolvedAgentId,
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

  let effectiveTemplateVars = templateVars;
  if (schedulingEnabled) {
    let toolsReady = false;
    try {
      const tools = await ensureCandidateInterviewTools(resolvedAgentId);
      toolsReady = tools?.success === true && tools.persisted === true;
      if (!toolsReady) {
        logger.warn(
          `[Bolna] candidate interview tools not ready agent=${resolvedAgentId} error=${tools?.error || tools?.putError || 'not persisted'}`
        );
      }
    } catch (err) {
      logger.warn(`[Bolna] candidate interview tools setup failed agent=${resolvedAgentId}: ${err?.message || err}`);
    }

    if (toolsReady && application?._id) {
      let offer;
      try {
        offer = await buildSlotOffer(
          String(application._id),
          promptContext.candidate_timezone || 'Asia/Kolkata'
        );
      } catch (err) {
        logger.warn(`[Bolna] interview slot offer skipped: ${err?.message || err}`);
      }

      const interviewSlotOptions = formatBakedSlotOptions(
        offer,
        promptContext.candidate_timezone_spoken || 'India time'
      );
      if (interviewSlotOptions) {
        effectiveTemplateVars = buildCandidateAgentTemplateVars(promptContext, {
          greetingOverride: settings.greetingOverride,
          extraSystemInstructions: extra,
          interviewSlotOptions,
        });
        Object.assign(userData, effectiveTemplateVars);
        const bakedPayload = assertUserDataWithinLimit(userData);
        if (!bakedPayload.ok) {
          logger.error(`[Bolna] ${bakedPayload.error}`);
          return { success: false, error: bakedPayload.error };
        }
        dialLogContext.userDataBytes = bakedPayload.bytes;
      }
    }
  }

  const renderedPrompt = renderPromptTemplateWithVars(systemPromptTemplate, effectiveTemplateVars);
  const renderedWelcome = renderPromptTemplateWithVars(welcomeTemplate, effectiveTemplateVars);
  const promptRenderToken = `render-${crypto.randomUUID()}`;
  const promptToDial = `${renderedPrompt}\n\n<!-- ${promptRenderToken} -->`;
  const promptHash = crypto.createHash('sha256').update(promptToDial).digest('hex');

  const templateAgent = await bolnaService.getAgent(resolvedAgentId);
  if (!templateAgent.success || !templateAgent.agent) {
    return {
      success: false,
      error: `Bolna candidate template agent could not be loaded: ${templateAgent.error || 'unknown error'}`,
    };
  }
  const cloneReady = templateCanBeCloned(templateAgent.agent);
  if (!cloneReady.ok) {
    return { success: false, error: cloneReady.error };
  }

  const cloneBody = buildCandidateToolsPutBody(templateAgent.agent, null, {
    systemPrompt: promptToDial,
    agentWelcomeMessage: renderedWelcome,
    agentName: `candidate-verification-${Date.now()}`,
  });
  if (!cloneBody.agent_config?.agent_name || !cloneBody.agent_prompts) {
    return {
      success: false,
      error: 'Bolna candidate template is missing agent_name or agent_prompts; refusing to create per-call clone.',
    };
  }

  const clone = await bolnaService.createAgent(cloneBody);
  if (!clone.success || !clone.agentId) {
    return {
      success: false,
      error: `Bolna per-call clone agent creation failed: ${clone.error || 'unknown error'}`,
    };
  }
  const cloneAgentId = String(clone.agentId);
  registerOwnedCloneAgent(cloneAgentId);

  logger.info('[Bolna] candidate verification dialing', {
    ...dialLogContext,
    promptToken: promptRenderToken,
    cloneAgentId,
  });

  const dialResult = await bolnaService.initiateCall({
    phone: formattedPhone,
    // Sanitised, not the raw doc field: initiateCall copies this into BOTH `name` and
    // `candidate_name` on user_data, and providers commonly bind a generic `name` key to
    // the assistant's own identity. promptContext.candidate_name has already been through
    // promptSafe(); passing candidate.fullName here would put the raw value back.
    candidateName: promptContext.candidate_name,
    agentId: cloneAgentId,
    jobTitle: promptContext.job_title,
    organisation: promptContext.company_name,
    userData,
    ...initiateExtras,
  });

  if (!dialResult.success) {
    const deleted = await bolnaService.deleteAgent(cloneAgentId);
    if (deleted?.success) unregisterOwnedCloneAgent(cloneAgentId);
    return dialResult;
  }

  const executionId = dialResult?.executionId;
  logger.info('[Bolna] candidate verification dial completed', {
    ...dialLogContext,
    promptToken: promptRenderToken,
    cloneAgentId,
    executionId: executionId ? String(executionId) : undefined,
  });

  return {
    ...dialResult,
    agentId: cloneAgentId,
    candidateId: bolnaEntityId(candidate),
    candidateName: promptContext.candidate_name,
    promptRenderToken,
    promptHash,
    question1: effectiveTemplateVars.candidate_verification_q1_line,
    ownedClone: true,
  };
}
