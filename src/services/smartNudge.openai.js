import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 400;

/**
 * Batched gpt-4o-mini JSON copy. Stays on mini — no gpt-4o escalation.
 * @param {Array<{ id: string, situation: string, audience: string, days?: number, label?: string }>} items
 * @returns {Promise<Array<{ id: string, title: string, message: string }>>}
 */
export async function generateNudgeCopies(items) {
  if (!items?.length) return [];
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const client = new OpenAI({ apiKey });
  const system =
    'Write short professional nudges for an ATS. Return JSON {"items":[{"id","title","message"}]}. ' +
    'title <= 50 chars, message <= 140 chars. Action-oriented. No salary, emails, or extra PII.';
  const user = JSON.stringify({
    items: items.map((it) => ({
      id: it.id,
      situation: it.situation,
      audience: it.audience,
      days: it.days ?? null,
      label: it.label || '',
    })),
  });
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS,
    temperature: 0.3,
  });
  const choice = completion.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('nudge copy hit max_tokens');
  }
  const parsed = parseJsonWithRepair(choice?.message?.content || '{}', 'smart-nudge');
  const rows = Array.isArray(parsed?.items) ? parsed.items : [];
  logger.info(
    '[smartNudge] openai copy batch size=%d prompt=%s completion=%s',
    items.length,
    completion.usage?.prompt_tokens,
    completion.usage?.completion_tokens
  );
  return rows.map((row) => ({
    id: String(row.id || ''),
    title: String(row.title || ''),
    message: String(row.message || ''),
  }));
}
