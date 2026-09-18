import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';
import { coerceBiasLlmResult } from './interviewBias.parse.js';
import { BIAS_MODEL } from '../constants/interviewBias.js';

const MAX_TOKENS = 900;
const MAX_UTTERANCES = 80;
const MAX_UTTERANCE_CHARS = 400;
const MAX_JD_CHARS = 8000;

const SYSTEM = [
  'You are an advisory hiring-bias auditor for recruiters.',
  'A human makes the final hire/reject decision. Do not recommend hire or reject.',
  'Only flag these categories:',
  '- protected_class: stereotyped or protected-class language in transcript or scorecard comment (age, gender, race, religion, disability, nationality, pregnancy, etc.).',
  '- score_mismatch: ratings or result that do not match what was said, or scoring on criteria absent from the job description.',
  '- vague_culture_fit: culture-fit or similar scores justified by vague, non-job criteria.',
  'Quotes MUST be exact substrings of the provided transcript or comment.',
  'If nothing material is found, return riskLevel "low" and empty flags.',
  'Return JSON only: {"riskLevel":"low|medium|high","flags":[{"category","label"}],"evidence":[{"quote","utteranceId","source"}],"reasons":["string"]}.',
  'source is transcript or scorecard_comment. utteranceId may be null.',
].join(' ');

/**
 * Truncate utterances for the prompt — ids + role + text only (no display names).
 * @param {Array<{ utteranceId?: string, speakerRole?: string, text?: string }>} utterances
 * @returns {Array<{ utteranceId: string|null, speakerRole: string, text: string }>}
 */
export function utterancesForPrompt(utterances) {
  const rows = [];
  for (const u of Array.isArray(utterances) ? utterances : []) {
    if (rows.length >= MAX_UTTERANCES) break;
    const text = String(u?.text || '').trim().slice(0, MAX_UTTERANCE_CHARS);
    if (!text) continue;
    rows.push({
      utteranceId: u.utteranceId ? String(u.utteranceId) : null,
      speakerRole: String(u.speakerRole || 'unknown'),
      text,
    });
  }
  return rows;
}

/**
 * Call gpt-4o-mini for an advisory bias report.
 * @param {{ utterances: object[], jobDescription: string, scorecard: object, interviewResult?: string }} input
 * @returns {Promise<{ riskLevel: string, flags: object[], evidence: object[], reasons: string[] }>}
 */
export async function generateBiasReport(input) {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const utterances = utterancesForPrompt(input.utterances);
  const jobDescription = String(input.jobDescription || '').trim().slice(0, MAX_JD_CHARS);
  const comment = String(input.scorecard?.comment || '');
  const transcriptText = utterances.map((u) => u.text).join('\n');
  const client = new OpenAI({ apiKey });
  const user = JSON.stringify({
    jobDescription,
    interviewResult: input.interviewResult || 'pending',
    scorecard: {
      ratings: input.scorecard?.ratings || [],
      comment,
    },
    utterances,
  });
  const completion = await client.chat.completions.create({
    model: BIAS_MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS,
    temperature: 0.1,
  });
  const choice = completion.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('bias report hit max_tokens');
  }
  const parsed = parseJsonWithRepair(choice?.message?.content || '{}', 'interview-bias');
  const coerced = coerceBiasLlmResult(parsed, { transcriptText, comment });
  if (!coerced) {
    throw new Error('bias report JSON invalid');
  }
  logger.info(
    '[interviewBias] openai prompt=%s completion=%s risk=%s flags=%d',
    completion.usage?.prompt_tokens,
    completion.usage?.completion_tokens,
    coerced.riskLevel,
    coerced.flags.length
  );
  return coerced;
}
