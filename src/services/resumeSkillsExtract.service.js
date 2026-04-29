import OpenAI from 'openai';
import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { extractRawTextFromFile } from './documentExtraction.service.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';

const MAX_TEXT_CHARS = 14000;
const DEFAULT_MODEL = process.env.RESUME_SKILLS_OPENAI_MODEL || 'gpt-4o-mini';
/** Role-based suggestion uses less JSON than resume extract; smaller cap = faster responses (override via RECOMMEND_SKILLS_MAX_TOKENS). */
const RECOMMEND_ROLE_MAX_TOKENS = (() => {
  const n = Number(process.env.RECOMMEND_SKILLS_MAX_TOKENS);
  if (Number.isFinite(n) && n >= 256 && n <= 4096) return Math.floor(n);
  return 1536;
})();

function getOpenAIClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Resume skill extraction requires OPENAI_API_KEY on the server'
    );
  }
  return new OpenAI({ apiKey });
}

/**
 * Flatten categorized skill arrays into Employee.skill schema rows (dedupe by case-insensitive name).
 * @param {Record<string, unknown>} parsed - Parsed JSON from model
 * @returns {{ skills: Array<{ name: string; level: string; category?: string }>; buckets: Record<string, string[]> }}
 */
export function categorizedJsonToEmployeeSkills(parsed) {
  const pairs = [
    ['technical', 'Technical'],
    ['soft', 'Soft Skills'],
    ['tools', 'Tools'],
    ['languages', 'Languages'],
    ['domains', 'Domains'],
    ['certifications', 'Certifications'],
  ];

  /** @type {Record<string, string[]>} */
  const buckets = {};
  /** @type {Array<{ name: string; level: string; category?: string }>} */
  const skills = [];
  const seen = new Set();

  for (const [key, categoryLabel] of pairs) {
    const raw = parsed[key];
    const arr = Array.isArray(raw) ? raw : [];
    buckets[key] = [];
    for (const item of arr) {
      const name = String(item ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!name) continue;
      buckets[key].push(name);
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      skills.push({
        name,
        level: 'Intermediate',
        category: categoryLabel,
      });
    }
  }

  return { skills, buckets };
}

/**
 * Extract resume/CV text and classify skills via OpenAI (JSON mode).
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<{ skills: Array<{ name: string; level: string; category?: string }>; buckets: Record<string, string[]> }>}
 */
export async function extractSkillsFromResumeBuffer(buffer, mimeType, filename) {
  let rawText = '';
  try {
    rawText = await extractRawTextFromFile(buffer, mimeType || '', filename || 'resume.pdf');
  } catch (e) {
    logger.warn('[resumeSkillsExtract] extractRawTextFromFile failed', { message: e?.message });
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      e?.message?.includes?.('Unsupported')
        ? 'Unsupported file type. Upload a PDF or DOCX resume.'
        : 'Could not read text from this file. Try another PDF/DOCX.'
    );
  }

  const text = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  if (!text || text.length < 40) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Not enough readable text in this resume (empty or scanned image PDF without OCR). Paste skills manually or try a text-based PDF/DOCX.'
    );
  }

  const client = getOpenAIClient();
  const model = DEFAULT_MODEL;

  const system = `You extract structured skills from resume text. Reply with a single JSON object only (no markdown).
Keys: name (string, candidate display name or empty), technical (string[]), soft (string[]), tools (string[]), languages (string[]), domains (string[]), certifications (string[]).
technical = programming languages, frameworks, databases, cloud, DevOps, ML/data stacks.
soft = interpersonal skills only.
tools = named products (Jira, Salesforce, VS Code).
languages = spoken languages only.
domains = industries (fintech, healthcare).
certifications = degrees/certs explicitly listed.
Normalize duplicates; Title Case proper nouns; empty arrays allowed.`;

  const user = `Resume text:\n${text}`;

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      temperature: 0.2,
    });
  } catch (e) {
    logger.error('[resumeSkillsExtract] OpenAI error', { message: e?.message });
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Skill extraction failed. Try again later.');
  }

  const rawJson = completion.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = parseJsonWithRepair(rawJson, 'resume-skills-extract');
  } catch (e) {
    logger.warn('[resumeSkillsExtract] JSON parse failed', { message: e?.message });
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Could not parse AI response.');
  }

  const out = categorizedJsonToEmployeeSkills(parsed);
  logger.info('[resumeSkillsExtract] extracted skills count=%s model=%s', out.skills.length, completion.model || model);
  return out;
}

/**
 * Recommend additional skills for a job role given what the employee already has (gap analysis via OpenAI JSON mode).
 *
 * @param {string} roleTitle
 * @param {Array<{ name?: string; level?: string; category?: string } | string>} currentSkillsRaw - employee's existing skills only (names sent to the model)
 * @returns {Promise<{ skills: Array<{ name: string; level: string; category?: string }>; buckets: Record<string, string[]> }>}
 */
export async function recommendSkillsForJobRole(roleTitle, currentSkillsRaw = []) {
  const trimmed = String(roleTitle || '')
    .trim()
    .slice(0, 500);
  if (!trimmed || trimmed.length < 2) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Enter a job role (at least 2 characters).');
  }

  const currentSkills = Array.isArray(currentSkillsRaw)
    ? currentSkillsRaw
        .map((x) => {
          if (typeof x === 'string') {
            const n = x.trim();
            return n ? { name: n } : null;
          }
          if (x && typeof x === 'object' && x.name != null) {
            const n = String(x.name).trim();
            return n ? { name: n, level: x.level, category: x.category } : null;
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 500)
    : [];

  const skillsLines =
    currentSkills.length === 0
      ? '(none listed)'
      : currentSkills
          .map((s, idx) => {
            const parts = [String(s.name)];
            if (s.level) parts.push(`level: ${s.level}`);
            if (s.category) parts.push(`category: ${s.category}`);
            return `${idx + 1}. ${parts.join(' · ')}`;
          })
          .join('\n');

  const client = getOpenAIClient();
  const model = DEFAULT_MODEL;

  const system = `You help employees grow toward a target job role. Reply with ONE JSON object only (no markdown).
Keys: technical (string[]), soft (string[]), tools (string[]), languages (string[]), domains (string[]), certifications (string[]).
technical = stacks still missing or weak for this role vs what they already have.
soft = interpersonal skills worth developing for this role.
tools = products/platforms to learn.
languages = spoken languages if relevant.
domains = industries or contexts to deepen.
certifications = credentials worth pursuing.

IMPORTANT: The user lists skills the employee ALREADY has. Recommend ONLY additional skills they still need to develop for the target role. Do NOT repeat or trivially rename existing skills (match names loosely; ignore case). If they already cover the role well, use mostly empty arrays with a few high-impact gaps only.

Emit roughly 8–24 NEW distinct skill names total across buckets (fewer if redundant). Empty arrays allowed. Each array item is one concise skill name.`;

  const user = `Target job role:\n${trimmed}\n\nSkills the employee already has:\n${skillsLines}\n\nWhat additional skills should they develop for this role? JSON only.`;

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: RECOMMEND_ROLE_MAX_TOKENS,
      temperature: 0.35,
    });
  } catch (e) {
    logger.error('[resumeSkillsExtract] recommend-by-role OpenAI error', { message: e?.message });
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Skill recommendation failed. Try again later.');
  }

  const rawJson = completion.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = parseJsonWithRepair(rawJson, 'skills-recommend-by-role');
  } catch (e) {
    logger.warn('[resumeSkillsExtract] recommend-by-role JSON parse failed', { message: e?.message });
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Could not parse AI response.');
  }

  const out = categorizedJsonToEmployeeSkills(parsed);
  const existingLower = new Set(currentSkills.map((s) => String(s.name).trim().toLowerCase()).filter(Boolean));
  const filteredSkills = out.skills.filter(
    (sk) => !existingLower.has(String(sk.name || '').trim().toLowerCase())
  );

  logger.info(
    '[resumeSkillsExtract] recommend-by-role count=%s afterDedupe=%s model=%s roleLen=%s existing=%s',
    out.skills.length,
    filteredSkills.length,
    completion.model || model,
    trimmed.length,
    currentSkills.length
  );
  return { skills: filteredSkills, buckets: out.buckets };
}
