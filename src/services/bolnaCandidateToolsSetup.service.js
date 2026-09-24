import bolnaService from './bolna.service.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

/**
 * Push the three AI interview-scheduling custom functions onto the Bolna candidate agent.
 * Mirrors bolnaCandidateExtractionSetup.service.js.
 *
 * Bolna has been seen to 200 a task_config PATCH without persisting it, so we ALWAYS read the
 * agent back and report `persisted`. The `apiTools` JSON is returned either way (token masked)
 * so a human can paste it into the Bolna dashboard. `%(application_id)s` param mapping is
 * spike-verified-later.
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

const TOOL_NAMES = ['get_interview_slots', 'hold_interview_slot', 'schedule_callback'];

function toolsPersisted(agent) {
  const tasks = agent?.tasks || agent?.agent_config?.tasks || [];
  const apiTools = tasks[0]?.tools_config?.api_tools;
  const names = new Set((apiTools?.tools || []).map((t) => t?.name));
  return TOOL_NAMES.every((n) => names.has(n));
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

  const tasks = JSON.parse(JSON.stringify(current.agent?.tasks || current.agent?.agent_config?.tasks || []));
  if (!tasks.length) {
    return {
      success: true,
      agentId: resolvedAgentId,
      persisted: false,
      apiTools,
      note: 'Agent has no tasks; paste apiTools into the Bolna dashboard.',
    };
  }
  tasks[0].tools_config = { ...(tasks[0].tools_config || {}), api_tools: buildCandidateApiTools() };

  const { apiKey, apiBase } = bolnaService.getConfig();
  let patchError = null;
  try {
    const res = await fetch(`${apiBase}/v2/agent/${resolvedAgentId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_config: { tasks } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) patchError = `${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`;
  } catch (err) {
    patchError = err?.message || String(err);
  }

  const after = await bolnaService.getAgent(resolvedAgentId);
  const persisted = after.success && toolsPersisted(after.agent);
  if (!persisted) {
    logger.warn(`[Bolna] candidate interview tools NOT persisted agent=${resolvedAgentId} patchError=${patchError || 'none'}`);
  }
  return {
    success: true,
    agentId: resolvedAgentId,
    alreadyConfigured: false,
    persisted,
    patchError,
    apiTools,
    ...(persisted ? {} : { note: 'Bolna did not persist tools via API; paste apiTools into the agent dashboard (Tools tab).' }),
  };
}
