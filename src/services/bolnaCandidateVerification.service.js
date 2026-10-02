import crypto from 'node:crypto';
import bolnaService from './bolna.service.js';
import config from '../config/config.js';
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
  buildCandidateApiTools,
  buildCandidateToolsPutBody,
  CANDIDATE_TOOL_NAMES,
  conversationMedia,
  templateCanBeCloned,
} from './bolnaCandidateToolsSetup.service.js';
import { ensureCandidateVerificationExtractions } from './bolnaCandidateExtractionSetup.service.js';
import {
  CANDIDATE_VERIFICATION_CATEGORY,
  CANDIDATE_VERIFICATION_FIELD_NAMES,
} from '../config/candidateVerificationDispositions.js';
import { registerOwnedCloneAgent, unregisterOwnedCloneAgent } from './bolnaOwnedAgents.js';
import { candidateVerificationSeedBody, seedCandidateVerificationCall } from './candidateVerificationCallSeed.js';

/** Immediate re-reads. Sleep is not readiness. state "created" and HTTP 201 are not either. */
const CLONE_READY_ATTEMPTS = 3;

function bolnaEntityId(doc) {
  if (!doc) return '';
  return String(doc._id ?? doc.id ?? '').trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function systemPromptOf(agent) {
  return (
    agent?.agent_prompts?.task_1?.system_prompt ||
    agent?.agent_config?.agent_prompts?.task_1?.system_prompt ||
    ''
  );
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
 * GET verifies the agent object POST /call will reference. It does not prove
 * what the runtime will speak. Do not treat state "created" or HTTP 201 as ready.
 */
function cloneGetMatches(agent, expected) {
  const prompt = systemPromptOf(agent);
  if (sha256(prompt) !== expected.promptHash) return { ok: false, reason: 'prompt_hash' };
  if (!expected.promptRenderToken || !prompt.includes(expected.promptRenderToken)) {
    return { ok: false, reason: 'render_token' };
  }
  const media = conversationMedia(agent);
  if (!media.voice || media.voice !== expected.media.voice) return { ok: false, reason: 'voice' };
  if (!media.language || media.language !== expected.media.language) return { ok: false, reason: 'language' };
  if (!media.input || !media.output || media.input !== expected.media.input || media.output !== expected.media.output) {
    return { ok: false, reason: 'telephony' };
  }
  if (!media.synthesizer || media.synthesizer !== expected.media.synthesizer) {
    return { ok: false, reason: 'synthesizer' };
  }
  const names = new Set(media.toolNames);
  const missing = CANDIDATE_TOOL_NAMES.filter((name) => !names.has(name));
  if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')}` };
  return { ok: true };
}

async function pollCloneReady(cloneId, expected) {
  let lastReason = 'not read';
  for (let attempt = 1; attempt <= CLONE_READY_ATTEMPTS; attempt += 1) {
    const read = await bolnaService.getAgent(cloneId);
    if (!read?.success || !read.agent) {
      lastReason = read?.error || 'GET failed';
      continue;
    }
    const match = cloneGetMatches(read.agent, expected);
    if (match.ok) return { ok: true };
    lastReason = match.reason;
  }
  return { ok: false, error: `Clone agent was not ready after ${CLONE_READY_ATTEMPTS} reads (${lastReason}).` };
}

async function extractionsReady(cloneId) {
  const ensured = await ensureCandidateVerificationExtractions(cloneId);
  if (!ensured.success) return { ok: false, error: ensured.error || 'disposition setup failed' };
  if (typeof bolnaService.listDispositions !== 'function') {
    return { ok: false, error: 'Bolna client is missing listDispositions' };
  }
  const listed = await bolnaService.listDispositions(cloneId);
  if (!listed.success) return { ok: false, error: listed.error || 'disposition read-back failed' };
  const names = new Set(
    (listed.dispositions || [])
      .filter((row) => row.category === CANDIDATE_VERIFICATION_CATEGORY)
      .map((row) => row.name)
  );
  const missing = CANDIDATE_VERIFICATION_FIELD_NAMES.filter((name) => !names.has(name));
  if (missing.length) return { ok: false, error: `clone dispositions missing: ${missing.join(', ')}` };
  return { ok: true };
}

async function safeDeleteAgent(cloneId, templateId) {
  if (!cloneId || cloneId === templateId) {
    return { success: false, error: 'refusing to delete the template agent' };
  }
  unregisterOwnedCloneAgent(cloneId);
  if (typeof bolnaService.deleteAgent !== 'function') {
    return { success: false, error: 'Bolna client is missing deleteAgent' };
  }
  return bolnaService.deleteAgent(cloneId);
}

/**
 * Read the template agent, POST a clone with this candidate's rendered prompt
 * and tools, and poll GET until the clone object matches. Does not dial.
 * Does not PATCH or PUT the template.
 *
 * @param {Object} p
 * @param {string} p.agentId - template agent (BOLNA_CANDIDATE_AGENT_ID). Not dialed.
 */
export async function prepareCandidateVerificationAgent({
  agentId,
  formattedPhone,
  candidate,
  job,
  application,
  jobTitleOverride,
}) {
  if (bolnaJobAndCandidateAgentsCollide()) {
    const errMsg =
      'Bolna is misconfigured: BOLNA_CANDIDATE_AGENT_ID must be a different agent than BOLNA_AGENT_ID. ' +
      'Applicant calls use a short-lived clone of the candidate template; sharing the job-posting agent makes recruiter and applicant scripts conflict. ' +
      'Add a second agent in Bolna and set BOLNA_CANDIDATE_AGENT_ID in .env.';
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }
  if (!config.bolna.toolToken) {
    return { success: false, error: 'BOLNA_TOOL_TOKEN is not configured.' };
  }
  if (typeof bolnaService.getAgent !== 'function') {
    return { success: false, error: 'Bolna client is missing getAgent; cannot copy the template agent.' };
  }

  const templateRead = await bolnaService.getAgent(agentId);
  if (!templateRead.success || !templateRead.agent) {
    return {
      success: false,
      error: `Bolna template agent could not be read: ${templateRead.error || 'missing agent'}`,
    };
  }
  const usable = templateCanBeCloned(templateRead.agent);
  if (!usable.ok) return { success: false, error: usable.error };

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
    if (kbCtx) extra = extra ? `${extra}\n\n${kbCtx}` : kbCtx;
  } catch (e) {
    logger.warn(`[KB] prompt context skipped: ${e.message}`);
  }

  const schedulingEnabled = promptContext.interview_scheduling_enabled === 'yes';
  const systemPromptTemplate = buildCandidateAgentPromptTemplate();
  const templateVars = buildCandidateAgentTemplateVars(promptContext, {
    greetingOverride: settings.greetingOverride,
    extraSystemInstructions: extra,
  });
  const missing = missingTemplateVars(systemPromptTemplate, templateVars, {
    allowEmpty: ['candidate_verification_additional_instructions'],
  });
  if (missing.length) {
    const errMsg = `Bolna prompt template has unsupplied placeholders: ${missing.join(', ')}`;
    logger.error(`[Bolna] ${errMsg}`);
    return { success: false, error: errMsg };
  }

  const welcomeTemplate = resolveCandidateAgentGreeting(promptContext, settings.greetingOverride, { raw: true });
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
    application_id: promptContext.application_id,
    candidate_timezone: promptContext.candidate_timezone,
    candidate_timezone_spoken: promptContext.candidate_timezone_spoken,
    interview_scheduling_enabled: promptContext.interview_scheduling_enabled,
    candidate_name: promptContext.candidate_name,
    job_title: promptContext.job_title,
    company_name: promptContext.company_name,
    ...templateVars,
  };

  const payloadCheck = assertUserDataWithinLimit(userData);
  if (!payloadCheck.ok) {
    logger.error(`[Bolna] ${payloadCheck.error}`);
    return { success: false, error: payloadCheck.error };
  }

  const jobTitleCheck = assertQ2LineMatchesJobTitle({
    canonicalJobTitle: promptContext.job_title,
    q2Line: templateVars.candidate_verification_q2_line,
    userDataJobTitle: userData.candidate_verification_job_title,
  });
  if (!jobTitleCheck.ok) {
    logger.error(`[Bolna] ${jobTitleCheck.error}`);
    return { success: false, error: jobTitleCheck.error };
  }

  let varsForPrompt = templateVars;
  if (schedulingEnabled && application?._id) {
    let offer;
    try {
      offer = await buildSlotOffer(String(application._id), promptContext.candidate_timezone || 'Asia/Kolkata');
    } catch (err) {
      logger.warn(`[Bolna] interview slot offer skipped: ${err?.message || err}`);
    }
    const interviewSlotOptions = formatBakedSlotOptions(offer, promptContext.candidate_timezone_spoken || 'India time');
    if (interviewSlotOptions) {
      varsForPrompt = buildCandidateAgentTemplateVars(promptContext, {
        greetingOverride: settings.greetingOverride,
        extraSystemInstructions: extra,
        interviewSlotOptions,
      });
      userData.interview_slot_options = varsForPrompt.interview_slot_options;
      const bakedPayload = assertUserDataWithinLimit(userData);
      if (!bakedPayload.ok) {
        logger.error(`[Bolna] ${bakedPayload.error}`);
        return { success: false, error: bakedPayload.error };
      }
    }
  }

  const renderedPrompt = renderPromptTemplateWithVars(systemPromptTemplate, varsForPrompt);
  const welcomeMessage = renderPromptTemplateWithVars(welcomeTemplate, varsForPrompt);
  const promptRenderToken = `render-${crypto.randomUUID()}`;
  const exactPrompt = `${renderedPrompt}\n\n<!-- ${promptRenderToken} -->`;
  const promptHash = sha256(exactPrompt);
  const question1 = varsForPrompt.candidate_verification_q1_line;
  const templateName =
    templateRead.agent.agent_name || templateRead.agent.agent_config?.agent_name || 'Candidate verification';

  const createBody = buildCandidateToolsPutBody(templateRead.agent, buildCandidateApiTools(), {
    systemPrompt: exactPrompt,
    agentWelcomeMessage: welcomeMessage,
    agentName: `${templateName} ${promptRenderToken}`,
  });
  if (!createBody.agent_config?.tasks?.length) {
    return { success: false, error: 'Refusing to create a clone with tasks: [].' };
  }
  if (createBody.agent_prompts?.task_1?.system_prompt !== exactPrompt) {
    return { success: false, error: 'Per-call prompt was not placed on the clone body.' };
  }

  if (typeof bolnaService.createAgent !== 'function') {
    return { success: false, error: 'Bolna client is missing createAgent; cannot dial on an isolated agent.' };
  }
  const created = await bolnaService.createAgent(createBody);
  if (!created.success || !created.agentId) {
    return { success: false, error: created.error || 'Bolna did not return an agent_id for this call.' };
  }
  if (created.agentId === agentId) {
    return {
      success: false,
      error: 'Bolna create agent returned the template agent id; refusing to dial the shared agent.',
    };
  }

  const expectedMedia = conversationMedia({ tasks: createBody.agent_config.tasks });
  const ready = await pollCloneReady(created.agentId, {
    promptHash,
    promptRenderToken,
    media: expectedMedia,
  });
  if (!ready.ok) {
    await safeDeleteAgent(created.agentId, agentId);
    return { success: false, error: ready.error };
  }

  const extractions = await extractionsReady(created.agentId);
  if (!extractions.ok) {
    await safeDeleteAgent(created.agentId, agentId);
    return { success: false, error: extractions.error };
  }

  registerOwnedCloneAgent(created.agentId);

  return {
    success: true,
    agentId: created.agentId,
    templateAgentId: agentId,
    userData,
    promptContext,
    promptRenderToken,
    promptHash,
    question1,
    candidateId: bolnaEntityId(candidate),
    candidateName: promptContext.candidate_name,
  };
}

/**
 * Place a candidate verification call on a clone of BOLNA_CANDIDATE_AGENT_ID.
 * The template agent is read-only. POST /call uses the clone id only.
 * A failed verify deletes the clone and does not dial.
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
  const prepared = await prepareCandidateVerificationAgent({
    agentId,
    formattedPhone,
    candidate,
    job,
    application,
    jobTitleOverride,
  });
  if (!prepared.success) return prepared;

  const dialResult = await bolnaService.initiateCall({
    phone: formattedPhone,
    candidateName: prepared.promptContext.candidate_name,
    agentId: prepared.agentId,
    jobTitle: prepared.promptContext.job_title,
    organisation: prepared.promptContext.company_name,
    userData: prepared.userData,
    ...initiateExtras,
  });

  if (!dialResult?.success || !dialResult.executionId) {
    await safeDeleteAgent(prepared.agentId, agentId);
    return {
      success: false,
      error: dialResult?.error || 'Bolna did not start the call.',
      agentId: prepared.agentId,
    };
  }

  const seeded = {
    ...dialResult,
    agentId: prepared.agentId,
    templateAgentId: agentId,
    candidateId: prepared.candidateId,
    candidateName: prepared.candidateName,
    promptRenderToken: prepared.promptRenderToken,
    promptHash: prepared.promptHash,
    question1: prepared.question1,
  };

  try {
    await seedCandidateVerificationCall(
      candidateVerificationSeedBody(seeded, {
        candidateId: prepared.candidateId,
        jobId: bolnaEntityId(job),
        recipientPhone: formattedPhone,
        businessName: prepared.candidateName,
      })
    );
  } catch (err) {
    // The call is already placed. Deleting the clone now would drop a live call.
    // Terminal webhook/poll still deletes it while this process remembers the id.
    logger.error(
      `[Bolna] CallRecord seed failed after dial clone=${prepared.agentId} execution=${dialResult.executionId}: ${err?.message || err}`
    );
  }

  return seeded;
}
