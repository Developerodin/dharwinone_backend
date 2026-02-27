/**
 * Bolna AI voice calling agent client.
 */

import { normalizePhone, validatePhone } from '../utils/phone.js';
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
  };
}

/**
 * Initiate a call via Bolna.
 * @param {Object} params - { phone, candidateName, jobTitle, organisation, jobType, location?, experienceLevel?, salaryRange?, fromPhoneNumber?, agentId? }
 * @returns {Promise<{ success: boolean, executionId?: string, error?: string }>}
 */
async function initiateCall(params) {
  const { apiKey, agentId: defaultAgentId, apiBase } = getConfig();
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

  const userData = {
    name: candidateName,
    candidate_name: candidateName,
  };
  if (jobTitle) userData.job_title = jobTitle;
  if (organisation) userData.organisation = organisation;
  if (jobType) userData.job_type = jobType;
  if (location) userData.location = location;
  if (experienceLevel) userData.experience_level = experienceLevel;
  if (salaryRange) userData.salary_range = salaryRange;

  // Merge any extra user_data fields (for rich candidate/job context)
  if (extraUserData && typeof extraUserData === 'object') {
    Object.assign(userData, extraUserData);
  }

  const payload = {
    agent_id: agentId || defaultAgentId,
    recipient_phone_number: recipientPhone,
    user_data: userData,
  };

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
 * Update an agent's system prompt via the Bolna PATCH API.
 * @param {string} agentId
 * @param {string} systemPrompt - The full prompt text (variables already interpolated)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function updateAgentPrompt(agentId, systemPrompt) {
  const { apiKey, apiBase } = getConfig();
  if (!apiKey) {
    return { success: false, error: 'BOLNA_API_KEY is not set.' };
  }
  if (!agentId || !systemPrompt) {
    return { success: false, error: 'agentId and systemPrompt are required.' };
  }

  try {
    const res = await fetch(`${apiBase}/v2/agent/${agentId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_prompts: {
          task_1: {
            system_prompt: systemPrompt,
          },
        },
      }),
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

export default {
  initiateCall,
  getExecutionDetails,
  getAgentExecutions,
  getConfig,
  updateAgentPrompt,
};

