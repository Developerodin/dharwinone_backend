import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';
import { parseLlmForecasts } from './hireForecast.parse.js';

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 900;

const SYSTEM = [
  'You forecast remaining days to fill job openings for recruiters.',
  'Use only the numeric signals given. Do not invent applicant counts or names.',
  'Return JSON {"forecasts":[{"id","daysLow","daysHigh","rationale"}]}.',
  'daysLow/daysHigh are remaining calendar days to hire remaining vacancies, integers.',
  'Stay close to the heuristic range. rationale <= 140 chars, recruiter-facing, no PII.',
].join(' ');

/**
 * One batched gpt-4o-mini call for page-level hire forecasts.
 * @param {Array<object>} items
 * @returns {Promise<Array<{ id: string, daysLow: number, daysHigh: number, rationale: string }>>}
 */
export async function generateHireForecasts(items) {
  if (!items?.length) return [];
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const client = new OpenAI({ apiKey });
  const user = JSON.stringify({
    items: items.map((it) => ({
      id: it.id,
      experienceLevel: it.experienceLevel || null,
      remainingVacancies: it.remainingVacancies,
      applicants: it.applicants,
      hired: it.hired,
      offered: it.offered,
      interview: it.interview,
      shortlisted: it.shortlisted,
      applied: it.applied,
      screening: it.screening,
      avgLiveFit: it.avgLiveFit,
      strongFitCount: it.strongFitCount,
      appsLast7Days: it.appsLast7Days,
      daysOpen: it.daysOpen,
      heuristicDaysLow: it.heuristicDaysLow,
      heuristicDaysHigh: it.heuristicDaysHigh,
      confidence: it.confidence,
    })),
  });
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
  });
  const choice = completion.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('hire forecast hit max_tokens');
  }
  const parsed = parseJsonWithRepair(choice?.message?.content || '{}', 'hire-forecast');
  logger.info(
    '[hireForecast] openai batch size=%d prompt=%s completion=%s',
    items.length,
    completion.usage?.prompt_tokens,
    completion.usage?.completion_tokens
  );
  return parseLlmForecasts(parsed);
}
