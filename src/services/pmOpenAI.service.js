import OpenAI from 'openai';
import crypto from 'crypto';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';

function getClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey });
}

export function hashPmPrompt(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

const DEFAULT_MODEL = process.env.PM_OPENAI_MODEL || 'gpt-4o-mini';
const ESCALATION_MODEL = process.env.PM_OPENAI_MODEL_ESCALATION || 'gpt-4o';

/**
 * Chat completion that must return a single JSON object (`response_format: json_object`).
 * Stricter JSON-schema structured outputs can be added later via the Responses API or `json_schema` where supported.
 * @param {{ system: string, user: string, context?: string }} args
 * @param {{ model?: string, maxTokens?: number }} opts
 */
export async function pmChatJsonObject({ system, user, context = 'pm-assistant' }, opts = {}) {
  const client = getClient();
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.3,
    });
  } catch (e) {
    logger.warn('[PM OpenAI] Primary model failed, trying escalation model', { message: e?.message });
    completion = await client.chat.completions.create({
      model: ESCALATION_MODEL,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.2,
    });
  }
  const choice = completion.choices?.[0];
  // A truncated response (hit max_tokens) is not valid JSON. Fail with a clear,
  // actionable message instead of a generic parse error.
  if (choice?.finish_reason === 'length') {
    throw new Error(
      `OpenAI response hit the max_tokens limit (${maxTokens}) and was truncated — the request is too large for one call`
    );
  }
  const text = choice?.message?.content || '{}';
  const parsed = parseJsonWithRepair(text, context);
  return {
    data: parsed,
    modelUsed: completion.model || model,
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
  };
}
