import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';
import { parseLlmFits } from './applicantFit.parse.js';

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 900;

const SYSTEM = [
  'You score applicants for a recruiter ATS table.',
  'Use only the job description, skills, and profile fields given. Do not invent names or contact data.',
  'Return JSON {"fits":[{"id","successProbability","culturalFit","rationale"}]}.',
  'successProbability is 0-100 integer: likelihood this applicant succeeds in the role from skills + JD + profile.',
  'culturalFit is fit | not_fit | unclear, inferred from JD culture/values language vs applicant bio/experience/cover letter.',
  'Stay close to heuristicSuccess. rationale <= 140 chars, recruiter-facing, no PII.',
].join(' ');

/**
 * One batched gpt-4o-mini call for page-level applicant fit scores.
 * @param {Array<object>} items
 * @returns {Promise<Array<{ id: string, successProbability: number, culturalFit: string, rationale: string }>>}
 */
export async function generateApplicantFits(items) {
  if (!items?.length) return [];
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const client = new OpenAI({ apiKey });
  const user = JSON.stringify({
    items: items.map((it) => ({
      id: it.id,
      job: it.job,
      applicant: it.applicant,
      heuristicSuccess: it.heuristicSuccess,
      matchedSkills: it.matchedSkills,
      missingSkills: it.missingSkills,
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
    throw new Error('applicant fit hit max_tokens');
  }
  const parsed = parseJsonWithRepair(choice?.message?.content || '{}', 'applicant-fit');
  logger.info(
    '[applicantFit] openai batch size=%d prompt=%s completion=%s',
    items.length,
    completion.usage?.prompt_tokens,
    completion.usage?.completion_tokens
  );
  return parseLlmFits(parsed);
}
