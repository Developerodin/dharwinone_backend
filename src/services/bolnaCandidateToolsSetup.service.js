import bolnaService from './bolna.service.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

/**
 * Push the three AI interview-scheduling custom functions onto the Bolna candidate agent.
 *
 * PATCH only accepts a whitelist (name, welcome, webhook, voice, prompts). `agent_config.tasks`
 * is not on that list, so a PATCH of tasks returns 200 and persists nothing. Rewriting tasks
 * is PUT /v2/agent/{id} with `agent_config.tasks[].tools_config.api_tools` plus the current
 * `agent_prompts` (both required). We round-trip the GET tasks so llm/voice/telephony stay,
 * then read the agent back. `persisted` is that read, not the PUT status.
 *
 * The `apiTools` JSON is returned either way (token masked) so a human can paste it into the
 * Bolna dashboard. The PUT merges these three tools into any custom tools already on that
 * task. An empty top-level `tasks` array is not a task list. If the conversation task is
 * missing llm, voice, or telephony, we do not PUT.
 */

function resolveCandidateAgentId(agentId) {
  return agentId || config.bolna.candidateAgentId || '';
}

export function buildCandidateApiTools(apiToken = `Bearer ${config.bolna.toolToken}`) {
  const base = `${String(config.backendPublicUrl || '').replace(/\/$/, '')}/v1/ai-tools`;
  return {
    tools: [
      {
        name: 'get_interview_slots',
        key: 'custom_task',
        description:
          'Use when the candidate is interested and ready to pick an interview time. Returns up to three available interview times to read out.',
        parameters: {
          type: 'object',
          properties: {
            application_id: { type: 'string', description: 'The application_id given in the prompt.' },
            tz: { type: 'string', description: 'Candidate IANA time zone, for example Asia/Kolkata.' },
          },
          required: ['application_id'],
        },
      },
      {
        name: 'hold_interview_slot',
        key: 'custom_task',
        description: 'Use when the candidate picks one of the offered interview times. Reserves it pending team confirmation.',
        parameters: {
          type: 'object',
          properties: {
            application_id: { type: 'string', description: 'The application_id given in the prompt.' },
            slot_id: { type: 'string', description: 'The slot_id of the option the candidate picked.' },
            tz: { type: 'string', description: 'Candidate IANA time zone.' },
          },
          required: ['application_id', 'slot_id'],
        },
      },
      {
        name: 'schedule_callback',
        key: 'custom_task',
        description:
          'Use when the candidate asks to be called back later. Books one call back after the given number of minutes.',
        parameters: {
          type: 'object',
          properties: {
            application_id: { type: 'string', description: 'The application_id given in the prompt.' },
            minutes: { type: 'string', description: 'Minutes from now, between 5 and 2880. Example: 10.' },
          },
          required: ['application_id', 'minutes'],
        },
      },
    ],
    tools_params: {
      get_interview_slots: {
        method: 'GET',
        url: `${base}/interview-slots`,
        api_token: apiToken,
        param: JSON.stringify({ application_id: '%(application_id)s', tz: '%(tz)s' }),
      },
      hold_interview_slot: {
        method: 'POST',
        url: `${base}/interview-slots/hold`,
        api_token: apiToken,
        param: JSON.stringify({ application_id: '%(application_id)s', slot_id: '%(slot_id)s', tz: '%(tz)s' }),
      },
      schedule_callback: {
        method: 'POST',
        url: `${base}/callback`,
        api_token: apiToken,
        param: JSON.stringify({ application_id: '%(application_id)s', minutes: '%(minutes)s' }),
      },
    },
  };
}

export const CANDIDATE_TOOL_NAMES = ['get_interview_slots', 'hold_interview_slot', 'schedule_callback'];
const TOOL_NAMES = CANDIDATE_TOOL_NAMES;

function nonEmptyTasks(value) {
  return Array.isArray(value) && value.length ? value : null;
}

/** Top-level `tasks: []` is not a task list. Use agent_config.tasks when the top level is empty. */
function agentTasks(agent) {
  return nonEmptyTasks(agent?.tasks) || nonEmptyTasks(agent?.agent_config?.tasks) || [];
}

/** Conversation task is the one whose tools the LLM sees. Fall back to the first task. */
function schedulingTask(tasks) {
  return tasks.find((t) => t?.task_type === 'conversation') || tasks[0] || null;
}

function toolsPersisted(agent) {
  const apiTools = schedulingTask(agentTasks(agent))?.tools_config?.api_tools;
  const names = new Set((apiTools?.tools || []).map((t) => t?.name));
  return TOOL_NAMES.every((n) => names.has(n));
}

/** True when all three interview-scheduling custom functions are on the conversation task. */
export function interviewSchedulingToolsVerified(agent) {
  return toolsPersisted(agent);
}

/** Present means we can copy llm, voice, and telephony back. A missing field is not a round-trip. */
function taskHasRoundTripMedia(task) {
  const tools = task?.tools_config;
  if (!tools || typeof tools !== 'object') return false;
  return Boolean(tools.llm_agent && tools.synthesizer && tools.input && tools.output);
}

function mergeApiTools(existing, incoming) {
  const prevTools = Array.isArray(existing?.tools) ? existing.tools : [];
  const nextTools = Array.isArray(incoming?.tools) ? incoming.tools : [];
  const nextNames = new Set(nextTools.map((t) => t?.name).filter(Boolean));
  const kept = prevTools.filter((t) => t?.name && !nextNames.has(t.name));
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...incoming,
    tools: [...kept, ...nextTools],
    tools_params: {
      ...(existing?.tools_params && typeof existing.tools_params === 'object' ? existing.tools_params : {}),
      ...(incoming?.tools_params || {}),
    },
  };
}

/** True when the conversation task has llm, voice, and telephony to copy onto a new agent. */
export function agentCanHostInterviewTools(agent) {
  const tasks = agentTasks(agent);
  if (!tasks.length) return false;
  return taskHasRoundTripMedia(schedulingTask(tasks));
}

/**
 * Voice, language, and telephony copied onto a clone. Empty strings mean the
 * template cannot be cloned: we must not POST tasks: [].
 */
export function conversationMedia(agent) {
  const tasks = agentTasks(agent);
  const task = schedulingTask(tasks);
  const tools = task?.tools_config && typeof task.tools_config === 'object' ? task.tools_config : {};
  const synth = tools.synthesizer && typeof tools.synthesizer === 'object' ? tools.synthesizer : {};
  const pc = synth.provider_config && typeof synth.provider_config === 'object' ? synth.provider_config : {};
  return {
    tasks,
    voice: String(pc.voice_id || pc.voice || synth.voice_id || synth.voice || '').trim(),
    language: String(tools.transcriber?.language || synth.language || pc.language || '').trim(),
    input: String(tools.input?.provider || '').trim(),
    output: String(tools.output?.provider || '').trim(),
    synthesizer: String(synth.provider || '').trim(),
    llm: Boolean(tools.llm_agent),
    toolNames: (tools.api_tools?.tools || []).map((t) => t?.name).filter(Boolean),
  };
}

/** Template is usable as a clone source. Empty tasks are a hard stop. */
export function templateCanBeCloned(agent) {
  const media = conversationMedia(agent);
  if (!media.tasks.length) {
    return { ok: false, error: 'Bolna template agent has no conversation task. Refusing to send tasks: [].' };
  }
  if (!media.llm || !media.synthesizer || !media.input || !media.output) {
    return {
      ok: false,
      error: 'Bolna template agent is missing llm, voice/synthesizer, or telephony input/output.',
    };
  }
  if (!media.voice || !media.language) {
    return { ok: false, error: 'Bolna template agent is missing a synthesizer voice or a language.' };
  }
  return { ok: true, media };
}

function promptsWithSystemPrompt(agentPrompts, systemPrompt) {
  const copy =
    agentPrompts && typeof agentPrompts === 'object' ? JSON.parse(JSON.stringify(agentPrompts)) : {};
  if (!copy.task_1 || typeof copy.task_1 !== 'object') copy.task_1 = {};
  copy.task_1.system_prompt = systemPrompt;
  return copy;
}

/**
 * PUT body Bolna documents for replacing tasks. `apiTools` is nested at
 * tasks[].tools_config.api_tools. agent_prompts is copied from GET so the PUT
 * does not blank the system prompt.
 *
 * `overrides.systemPrompt` replaces task_1.system_prompt on the RETURNED body
 * only (used when creating an isolated per-call agent). It does not write the
 * source agent.
 * @param {Object} agent - GET /v2/agent response
 * @param {Object|null} apiTools - buildCandidateApiTools() (live token), or null to leave tools as copied
 * @param {{ systemPrompt?: string, agentWelcomeMessage?: string, agentName?: string }} [overrides]
 */
export function buildCandidateToolsPutBody(agent, apiTools, overrides = {}) {
  const tasks = JSON.parse(JSON.stringify(agentTasks(agent)));
  const task = schedulingTask(tasks);
  if (task && apiTools) {
    task.tools_config = {
      ...(task.tools_config || {}),
      api_tools: mergeApiTools(task.tools_config?.api_tools, apiTools),
    };
  }
  const source = agent?.agent_config ? { ...agent, ...agent.agent_config } : agent || {};
  const agentConfig = {
    agent_name: overrides.agentName || source.agent_name,
    tasks,
  };
  for (const key of [
    'agent_welcome_message',
    'webhook_url',
    'agent_type',
    'ingest_source_config',
    'calling_guardrails',
    'call_summary_enabled',
  ]) {
    if (source[key] !== undefined) agentConfig[key] = source[key];
  }
  if (overrides.agentWelcomeMessage) {
    agentConfig.agent_welcome_message = overrides.agentWelcomeMessage;
  }
  const prompts = agent?.agent_prompts ?? agent?.agent_config?.agent_prompts;
  return {
    agent_config: agentConfig,
    agent_prompts: overrides.systemPrompt ? promptsWithSystemPrompt(prompts, overrides.systemPrompt) : prompts,
  };
}

export async function ensureCandidateInterviewTools(agentId) {
  const resolvedAgentId = resolveCandidateAgentId(agentId);
  // Response copy never carries the real token.
  const apiTools = buildCandidateApiTools('Bearer <BOLNA_TOOL_TOKEN>');
  if (!resolvedAgentId) return { success: false, error: 'BOLNA_CANDIDATE_AGENT_ID is not configured.', apiTools };
  if (!config.bolna.toolToken) return { success: false, error: 'BOLNA_TOOL_TOKEN is not configured.', apiTools };

  const current = await bolnaService.getAgent(resolvedAgentId);
  if (!current.success) return { success: false, error: current.error || 'Failed to read Bolna agent', apiTools };
  if (toolsPersisted(current.agent)) {
    return { success: true, agentId: resolvedAgentId, alreadyConfigured: true, persisted: true, apiTools };
  }

  const tasks = agentTasks(current.agent);
  if (!tasks.length) {
    return {
      success: true,
      agentId: resolvedAgentId,
      persisted: false,
      apiTools,
      note: 'Agent has no tasks; paste apiTools into the Bolna dashboard.',
    };
  }

  if (!taskHasRoundTripMedia(schedulingTask(tasks))) {
    return {
      success: false,
      agentId: resolvedAgentId,
      persisted: false,
      apiTools,
      error: 'Bolna agent is missing llm, voice, or telephony fields; refusing to PUT tasks.',
    };
  }

  const body = buildCandidateToolsPutBody(current.agent, buildCandidateApiTools());
  if (!body.agent_config?.agent_name || !body.agent_prompts) {
    return {
      success: false,
      agentId: resolvedAgentId,
      persisted: false,
      apiTools,
      error: 'Bolna agent is missing agent_name or agent_prompts; refusing to PUT tasks.',
    };
  }

  let putError = null;
  if (typeof bolnaService.putAgent !== 'function') {
    putError = 'Bolna client is missing putAgent.';
  } else {
    const put = await bolnaService.putAgent(resolvedAgentId, body);
    if (!put.success) putError = put.error || 'PUT failed';
  }

  const after = await bolnaService.getAgent(resolvedAgentId);
  const persisted = after.success && toolsPersisted(after.agent);
  if (!persisted) {
    logger.warn(`[Bolna] candidate interview tools NOT persisted agent=${resolvedAgentId} putError=${putError || 'none'}`);
  }
  return {
    success: true,
    agentId: resolvedAgentId,
    alreadyConfigured: false,
    persisted,
    putError,
    apiTools,
    ...(persisted ? {} : { note: 'Bolna did not persist tools via API; paste apiTools into the agent dashboard (Tools tab).' }),
  };
}
