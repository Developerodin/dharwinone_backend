/**
 * Bolna AI voice calling agent client.
 */

import { normalizePhone, validatePhone, validatePhonePlausible } from '../utils/phone.js';
import logger from '../config/logger.js';
import config from '../config/config.js';

/** Caller ID priority: request > BOLNA_FROM_PHONE_NUMBER > CALLER_ID. */
function getCallerId(params) {
  return params.from_phone_number || params.fromPhoneNumber || config.bolna.fromPhoneNumber || '';
}

function getConfig() {
  return {
    apiKey: config.bolna.apiKey || '',
    agentId: config.bolna.agentId || '6afbccea-0495-4892-937c-6a5c9af12440',
    apiBase: config.bolna.apiBase || 'https://api.bolna.ai',
    maxCallDurationSeconds: config.bolna.maxCallDurationSeconds,
  };
}

/**
 * Initiate a call via Bolna.
 * @param {Object} params - { phone, candidateName, jobTitle, organisation, jobType, location?, experienceLevel?, salaryRange?, fromPhoneNumber?, agentId?, maxCallDurationSeconds? }
 * @returns {Promise<{ success: boolean, executionId?: string, error?: string }>}
 */
async function initiateCall(params) {
  const { apiKey, agentId: defaultAgentId, apiBase, maxCallDurationSeconds } = getConfig();
  if (!apiKey) {
    return { success: false, error: 'BOLNA_API_KEY is not set. Add it to .env to use Bolna calling.' };
  }

  const {
    phone,
    candidateName,
    jobTitle,
    organisation,
    jobType,
    location,
    experienceLevel,
    salaryRange,
    agentId,
    userData: extraUserData,
  } = params;

  // Callers may pass snake_case aliases alongside camelCase (legacy Bolna user_data shape)
  const resolvedCandidateName = candidateName || params.candidate_name;
  const resolvedJobTitle = jobTitle || params.job_title;
  const resolvedOrganisation = organisation || params.company_name;
  const resolvedJobType = jobType || params.job_type;
  const resolvedExperienceLevel = experienceLevel || params.experience_level;
  const resolvedSalaryRange = salaryRange || params.salary_range;

  if (!phone) {
    return { success: false, error: 'Missing required field: phone' };
  }

  const recipientPhone = normalizePhone(phone);
  if (!recipientPhone || !validatePhone(recipientPhone)) {
    return {
      success: false,
      error: 'Invalid phone number format. Use E.164 (e.g. +918755887760) or 10-digit number.',
    };
  }
  if (!validatePhonePlausible(recipientPhone)) {
    return {
      success: false,
      error:
        'Phone number is not a valid callable line (e.g. US/Canada needs a real area code and exchange, not all zeros). ' +
        'Replace placeholder numbers like +10000000000 with a real mobile number.',
    };
  }

  const userData = {
    name: resolvedCandidateName,
    candidate_name: resolvedCandidateName,
  };
  if (resolvedJobTitle) userData.job_title = resolvedJobTitle;
  if (resolvedOrganisation) userData.organisation = resolvedOrganisation;
  if (resolvedJobType) userData.job_type = resolvedJobType;
  if (location) userData.location = location;
  if (resolvedExperienceLevel) userData.experience_level = resolvedExperienceLevel;
  if (resolvedSalaryRange) userData.salary_range = resolvedSalaryRange;

  // Merge any extra user_data fields (for rich candidate/job context)
  if (extraUserData && typeof extraUserData === 'object') {
    Object.assign(userData, extraUserData);
  }

  // Job-posting verification lists use employer fields under organisation_name / listing_employer_name.
  // Generic `organisation` is often wired to assistant identity in Bolna templates — strip it for this flow only.
  if (userData.call_type === 'job_posting_verification') {
    delete userData.organisation;
  }

  const payload = {
    agent_id: agentId || defaultAgentId,
    recipient_phone_number: recipientPhone,
    user_data: userData,
  };

  const durationCap =
    params.maxCallDurationSeconds != null
      ? Number(params.maxCallDurationSeconds)
      : maxCallDurationSeconds != null
        ? Number(maxCallDurationSeconds)
        : null;
  if (durationCap != null && Number.isFinite(durationCap) && durationCap > 0) {
    payload.max_call_duration_seconds = Math.round(durationCap);
  } else if (durationCap === 0) {
    logger.warn(
      'Bolna POST /call: max_call_duration_seconds omitted (BOLNA_MAX_CALL_DURATION_SECONDS=0). ' +
        'Call length is controlled only by Bolna → Agent → Call tab → Total Call Timeout (defaults are often ~2–5 minutes).'
    );
  }

  logger.info(
    `Bolna POST /call agent_id=${payload.agent_id} recipient_e164_tail=${recipientPhone.slice(-4)} ` +
      `max_call_duration_seconds=${payload.max_call_duration_seconds ?? 'omitted — set Total Call Timeout in Bolna → Agent → Call tab if calls drop around 1–2 min'}`
  );

  const callerIdRaw = getCallerId(params);
  if (callerIdRaw) {
    const normalizedCallerId = normalizePhone(callerIdRaw);
    if (normalizedCallerId && validatePhone(normalizedCallerId)) {
      payload.from_phone_number = normalizedCallerId;
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let res;
    try {
      res = await fetch(`${apiBase}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return { success: false, error: 'Request timeout: Bolna API did not respond within 30 seconds.' };
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore JSON parse error */
    }

    if (!res.ok) {
      const message = (data && (data.message || data.error || data.detail)) || text || res.statusText;
      if (
        message &&
        (String(message).toLowerCase().includes('trial') ||
          String(message).toLowerCase().includes('verified'))
      ) {
        logger.warn(
          `Bolna trial/verified error (${res.status}): ${message}. ` +
            `recipient_phone_number=${recipientPhone}, from_phone_number=${payload.from_phone_number || '(not set)'}.`
        );
      } else {
        logger.error(`Bolna API error (${res.status}): ${message}`);
      }
      return { success: false, error: message };
    }

    const executionId = data.id ?? data.execution_id ?? data.executionId;
    if (!executionId) {
      return { success: false, error: 'Bolna API did not return an execution ID.' };
    }

    return { success: true, executionId: String(executionId) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Get execution details for a call from Bolna.
 * @param {string} executionId
 * @returns {Promise<{ success: boolean, details?: Object, error?: string }>}
 */
async function getExecutionDetails(executionId) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) {
    return { success: false, error: 'BOLNA_API_KEY is not set.' };
  }

  try {
    const res = await fetch(`${apiBase}/execution/${executionId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 404) {
      return {
        success: true,
        notFound: true,
        details: {
          execution_id: executionId,
          id: executionId,
          status: 'unknown',
          error_message: 'Execution not found or expired in Bolna AI system.',
        },
      };
    }

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore JSON parse error */
    }

    if (!res.ok) {
      const message = (data && data.error_message) || text || res.statusText;
      return { success: false, error: message };
    }

    const details = { ...data, execution_id: data.execution_id ?? data.id ?? executionId };
    return { success: true, details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Get FULL execution details including telephony_data (recording_url,
 * provider_call_id, etc). NOTE: this uses `/executions/{id}` (plural) — unlike
 * `/execution/{id}` (singular, getExecutionDetails) which returns only a status
 * stub WITHOUT telephony_data.
 * @param {string} executionId
 * @returns {Promise<{ success: boolean, details?: Object, notFound?: boolean, error?: string }>}
 */
async function getExecutionFull(executionId) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) return { success: false, error: 'BOLNA_API_KEY is not set.' };
  if (!executionId) return { success: false, error: 'executionId is required.' };

  try {
    const res = await fetch(`${apiBase}/executions/${executionId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore */
    }
    if (res.status === 404) return { success: false, notFound: true, error: 'execution not found' };
    if (!res.ok) {
      return { success: false, error: (data && (data.detail || data.message || data.error)) || text || res.statusText };
    }
    return { success: true, details: data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get executions for an agent.
 * @param {Object} options - { agentId, page_number, page_size }
 * @returns {Promise<{ success: boolean, data?: Array, total?: number, has_more?: boolean, error?: string }>}
 */
async function getAgentExecutions(options = {}) {
  const { apiKey, agentId, apiBase } = getConfig();
  const aid = options.agentId || agentId;
  if (!apiKey) {
    return { success: false, error: 'BOLNA_API_KEY is not set.' };
  }
  if (!aid) {
    return { success: false, error: 'Agent ID is required.' };
  }

  const page = Math.max(1, Number(options.page_number) || 1);
  const size = Math.min(50, Math.max(1, Number(options.page_size) || 50));

  try {
    const res = await fetch(
      `${apiBase}/v2/agent/${aid}/executions?page_number=${page}&page_size=${size}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore JSON parse error */
    }

    if (!res.ok) {
      const message = (data && (data.message || data.error)) || text || res.statusText;
      return { success: false, error: message };
    }

    const list = data.data || [];
    const total = data.total ?? list.length;
    const hasMore = data.has_more === true;
    return {
      success: true,
      data: list,
      total,
      has_more: hasMore,
      page_number: data.page_number,
      page_size: data.page_size,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Fetch an agent's full config from Bolna (GET /v2/agent/{id}).
 * Used to VERIFY a PATCH actually landed before placing a call — Bolna renders
 * the system prompt with a delay/cache, so a call placed immediately after a
 * PATCH can otherwise run against a stale prompt.
 * @param {string} agentId
 * @returns {Promise<{ success: boolean, agent?: Object, error?: string }>}
 */
async function getAgent(agentId) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) return { success: false, error: 'BOLNA_API_KEY is not set.' };
  if (!agentId) return { success: false, error: 'agentId is required.' };

  try {
    const res = await fetch(`${apiBase}/v2/agent/${agentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore JSON parse error */
    }

    if (!res.ok) {
      const message = (data && (data.message || data.error)) || text || res.statusText;
      return { success: false, error: message };
    }
    return { success: true, agent: data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update an agent's system prompt via the Bolna PATCH API.
 * @param {string} agentId
 * @param {string} systemPrompt - The full prompt text (variables already interpolated)
 * @param {{ agentWelcomeMessage?: string }} [options] - If set, patches `agent_config.agent_welcome_message` so the dashboard welcome does not override at call connect.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function updateAgentPrompt(agentId, systemPrompt, options = {}) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) {
    return { success: false, error: 'BOLNA_API_KEY is not set.' };
  }
  if (!agentId || !systemPrompt) {
    return { success: false, error: 'agentId and systemPrompt are required.' };
  }

  const body = {
    agent_prompts: {
      task_1: {
        system_prompt: systemPrompt,
      },
    },
  };
  if (options.agentWelcomeMessage != null && String(options.agentWelcomeMessage).length > 0) {
    body.agent_config = {
      agent_welcome_message: String(options.agentWelcomeMessage),
    };
  }

  try {
    const res = await fetch(`${apiBase}/v2/agent/${agentId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch { /* ignore */ }

    if (!res.ok) {
      const message = (data && (data.message || data.error)) || text || res.statusText;
      logger.error(`Bolna PATCH prompt error (${res.status}): ${message}`);
      return { success: false, error: message };
    }

    logger.info(`Bolna agent prompt updated for ${agentId}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Bolna PATCH prompt exception: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Verify a Bolna executionId actually exists upstream before persisting it.
 *
 * Returns:
 *   { exists: true,  details }              — Bolna 200, real execution
 *   { exists: false, notFound: true }       — Bolna 404, no such execution (ghost)
 *   { exists: false, error: '<msg>' }       — transport error / 5xx (caller
 *                                             should NOT persist on this signal)
 *
 * Why this exists:
 *   Webhook + backfill paths used to insert CallRecord blindly off whatever
 *   `executionId` the payload carried. A replayed webhook, a foreign-tenant
 *   exec leaking under a shared agent_id, or a typo'd payload would land
 *   permanently as a "ghost call" in our DB. Routing through this helper at
 *   every entry point makes Bolna the single source of truth.
 */
async function verifyExecutionExistsInBolna(executionId) {
  if (!executionId) return { exists: false, error: 'missing_execution_id' };
  const result = await getExecutionDetails(String(executionId));
  if (!result.success) {
    return { exists: false, error: result.error || 'transport_error' };
  }
  if (result.notFound === true) {
    return { exists: false, notFound: true };
  }
  return { exists: true, details: result.details };
}

async function bolnaApiRequest(method, path, body) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) return { success: false, error: 'BOLNA_API_KEY is not set.' };

  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const message = (data && (data.message || data.error || data.detail)) || text || res.statusText;
      return { success: false, error: message, status: res.status };
    }
    return { success: true, data, status: res.status };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List dispositions, optionally scoped to an agent.
 * @param {string} [agentId]
 */
async function listDispositions(agentId) {
  const q = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
  const result = await bolnaApiRequest('GET', `/dispositions${q}`);
  if (!result.success) return result;
  const raw = result.data;
  const dispositions = Array.isArray(raw) ? raw : raw.data || raw.dispositions || [];
  return { success: true, dispositions };
}

/**
 * Create one disposition linked to an agent.
 */
async function createDisposition(agentId, disposition) {
  if (!agentId) return { success: false, error: 'agentId is required.' };
  const result = await bolnaApiRequest('POST', '/dispositions/', {
    agent_id: agentId,
    ...disposition,
  });
  if (!result.success) return result;
  const id = result.data?.id || result.data?.disposition_id;
  return { success: true, id, disposition: result.data };
}

/**
 * Bulk-create dispositions for an agent (atomic).
 */
async function bulkCreateDispositions(agentId, dispositions) {
  if (!agentId) return { success: false, error: 'agentId is required.' };
  if (!Array.isArray(dispositions) || dispositions.length === 0) {
    return { success: false, error: 'dispositions array is required.' };
  }
  const result = await bolnaApiRequest('POST', '/dispositions/bulk', {
    agent_id: agentId,
    dispositions,
  });
  if (!result.success) return result;
  return { success: true, ids: result.data?.ids || [], message: result.data?.message };
}

export default {
  initiateCall,
  getExecutionDetails,
  getExecutionFull,
  getAgentExecutions,
  getAgent,
  getConfig,
  updateAgentPrompt,
  verifyExecutionExistsInBolna,
  listDispositions,
  createDisposition,
  bulkCreateDispositions,
};

