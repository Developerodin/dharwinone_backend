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

const VALID_LEVELS = new Set(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
const MAX_PUBLIC_EXPERIENCES = 20;
const MAX_PUBLIC_QUALIFICATIONS = 15;
const MAX_PUBLIC_SOCIAL_LINKS = 10;
const MAX_PUBLIC_SKILLS = 50;
const MAX_PUBLIC_SKILL_NAME = 80;
const MAX_PUBLIC_SHORT_STRING = 200;
const MAX_PUBLIC_DESCRIPTION = 2000;
const MAX_PUBLIC_URL = 500;

/** ISO 3166-1 alpha-2 codes we accept from the model (uppercase). */
const VALID_COUNTRY_CODES = new Set([
  'AF', 'AL', 'DZ', 'AR', 'AU', 'AT', 'BH', 'BD', 'BE', 'BR', 'BG', 'CA', 'CL', 'CN', 'CO', 'CZ', 'DK', 'EG', 'ET',
  'FI', 'FR', 'DE', 'GH', 'GR', 'HK', 'HU', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IL', 'IT', 'JP', 'JO', 'KE', 'KW', 'LB',
  'MY', 'MX', 'MA', 'NP', 'NL', 'NZ', 'NG', 'NO', 'OM', 'PK', 'PH', 'PL', 'PT', 'QA', 'RO', 'RU', 'SA', 'SG', 'ZA',
  'KR', 'ES', 'LK', 'SE', 'CH', 'TW', 'TH', 'TR', 'AE', 'GB', 'US', 'VN',
]);

const DIAL_CODE_TO_COUNTRY = {
  '+1': 'US',
  '+91': 'IN',
  '+44': 'GB',
  '+61': 'AU',
  '+971': 'AE',
  '+966': 'SA',
  '+65': 'SG',
  '+81': 'JP',
  '+86': 'CN',
  '+49': 'DE',
  '+33': 'FR',
};

/** Local digit caps for stripping embedded dial prefixes when countryCode is known. */
const COUNTRY_PHONE_META = {
  IN: { dialDigits: '91', maxLength: 10 },
  US: { dialDigits: '1', maxLength: 10 },
  CA: { dialDigits: '1', maxLength: 10 },
  GB: { dialDigits: '44', maxLength: 11 },
  AU: { dialDigits: '61', maxLength: 9 },
  AE: { dialDigits: '971', maxLength: 9 },
  SA: { dialDigits: '966', maxLength: 9 },
  SG: { dialDigits: '65', maxLength: 8 },
  JP: { dialDigits: '81', maxLength: 10 },
  CN: { dialDigits: '86', maxLength: 11 },
  DE: { dialDigits: '49', maxLength: 12 },
  FR: { dialDigits: '33', maxLength: 9 },
};

/**
 * Read resume text from a PDF/DOCX buffer. Throws ApiError on unsupported type or unreadable file.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function readResumeTextFromBuffer(buffer, mimeType, filename) {
  let rawText = '';
  try {
    rawText = await extractRawTextFromFile(buffer, mimeType || '', filename || 'resume.pdf', { skipYoutubeLinks: true });
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
      'Not enough readable text in this resume (empty or scanned image PDF without OCR). Try a text-based PDF/DOCX.'
    );
  }

  return text;
}

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email.slice(0, 254);
}

function normalizeFullName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length < 2) return null;
  return name.slice(0, 120);
}

function normalizeCountryCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (VALID_COUNTRY_CODES.has(upper)) return upper;
  const dial = s.startsWith('+') ? s : null;
  if (dial && DIAL_CODE_TO_COUNTRY[dial]) return DIAL_CODE_TO_COUNTRY[dial];
  return null;
}

export function normalizePhoneDigits(raw, countryCode) {
  const trimmed = String(raw || '').trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits || digits.length < 6) return null;

  const cc = normalizeCountryCode(countryCode);
  const meta = cc ? COUNTRY_PHONE_META[cc] : null;
  if (meta?.dialDigits) {
    const startedWithPlus = trimmed.startsWith('+');
    if (
      digits.startsWith(meta.dialDigits) &&
      (startedWithPlus || digits.length > meta.maxLength) &&
      digits.length - meta.dialDigits.length <= meta.maxLength
    ) {
      digits = digits.slice(meta.dialDigits.length);
    } else if (digits.length <= meta.maxLength) {
      // Already local digits for this country.
    }
  }

  return digits.slice(0, 20);
}

function trimPublicString(raw, maxLen = MAX_PUBLIC_SHORT_STRING) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, maxLen);
}

function parsePublicApplyJsonArray(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function normalizePublicYear(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1900 || n > 3000) return undefined;
  return Math.floor(n);
}

function normalizePublicDate(raw) {
  if (raw == null || raw === '') return undefined;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^\d{4}$/.test(s)) {
    const d = new Date(`${s}-01-01T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function normalizeQualificationItem(item) {
  if (!item || typeof item !== 'object') return null;
  const degree = trimPublicString(item.degree ?? item.qualification);
  const institute = trimPublicString(item.institute ?? item.school ?? item.university ?? item.college);
  if (!degree || !institute) return null;
  const location = trimPublicString(item.location);
  const startYear = normalizePublicYear(item.startYear);
  const endYear = normalizePublicYear(item.endYear);
  const description = trimPublicString(item.description, MAX_PUBLIC_DESCRIPTION);
  return {
    degree,
    institute,
    ...(location ? { location } : {}),
    ...(startYear != null ? { startYear } : {}),
    ...(endYear != null ? { endYear } : {}),
    ...(description ? { description } : {}),
  };
}

function normalizeExperienceItem(item) {
  if (!item || typeof item !== 'object') return null;
  const company = trimPublicString(item.company ?? item.employer ?? item.organization);
  const role = trimPublicString(item.role ?? item.title ?? item.position ?? item.jobTitle);
  if (!company || !role) return null;
  const currentlyWorking = Boolean(item.currentlyWorking ?? item.current ?? item.isCurrent);
  const startDate = normalizePublicDate(item.startDate ?? item.from);
  const endDate = currentlyWorking ? undefined : normalizePublicDate(item.endDate ?? item.to);
  const description = trimPublicString(item.description, MAX_PUBLIC_DESCRIPTION);
  return {
    company,
    role,
    currentlyWorking,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(description ? { description } : {}),
  };
}

function inferSocialPlatform(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('linkedin.com')) return 'LinkedIn';
  if (lower.includes('github.com')) return 'GitHub';
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'Twitter';
  if (lower.includes('behance.net')) return 'Behance';
  if (lower.includes('dribbble.com')) return 'Dribbble';
  return 'Website';
}

function normalizeSocialLinkItem(item) {
  if (!item || typeof item !== 'object') return null;
  let url = String(item.url ?? item.link ?? '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) url = `https://${url}`;
    else return null;
  }
  url = url.slice(0, MAX_PUBLIC_URL);
  const platform = trimPublicString(item.platform, 80) || inferSocialPlatform(url);
  if (!platform) return null;
  return { platform, url };
}

/**
 * Normalize client-supplied qualifications from public apply (JSON string or array).
 * Invalid rows are dropped so Employee.create cannot fail validation.
 * @param {unknown} raw
 */
export function normalizePublicApplyQualifications(raw) {
  return parsePublicApplyJsonArray(raw)
    .map((item) => normalizeQualificationItem(item))
    .filter(Boolean)
    .slice(0, MAX_PUBLIC_QUALIFICATIONS);
}

/**
 * Normalize client-supplied experiences from public apply (JSON string or array).
 * @param {unknown} raw
 */
export function normalizePublicApplyExperiences(raw) {
  return parsePublicApplyJsonArray(raw)
    .map((item) => normalizeExperienceItem(item))
    .filter(Boolean)
    .slice(0, MAX_PUBLIC_EXPERIENCES);
}

/**
 * Normalize client-supplied social links from public apply (JSON string or array).
 * @param {unknown} raw
 */
export function normalizePublicApplySocialLinks(raw) {
  return parsePublicApplyJsonArray(raw)
    .map((item) => normalizeSocialLinkItem(item))
    .filter(Boolean)
    .slice(0, MAX_PUBLIC_SOCIAL_LINKS);
}

function experienceDedupeKey(item) {
  return `${String(item?.company || '').trim().toLowerCase()}|${String(item?.role || '').trim().toLowerCase()}`;
}

function qualificationDedupeKey(item) {
  return `${String(item?.degree || '').trim().toLowerCase()}|${String(item?.institute || '').trim().toLowerCase()}`;
}

function socialLinkDedupeKey(item) {
  return String(item?.url || '').trim().toLowerCase();
}

function appendUniquePublicApplyRows(existing = [], incoming = [], keyFn, isValid) {
  const have = new Set((existing || []).map((item) => keyFn(item)));
  const fresh = [];
  for (const item of incoming || []) {
    if (!isValid(item)) continue;
    const key = keyFn(item);
    if (have.has(key)) continue;
    have.add(key);
    fresh.push(item);
  }
  return fresh.length > 0 ? [...(existing || []), ...fresh] : existing || [];
}

/** Append-only merge for existing candidates — never overwrite recruiter-entered rows. */
export function mergePublicApplyExperiences(existing = [], incoming = []) {
  return appendUniquePublicApplyRows(
    existing,
    incoming,
    experienceDedupeKey,
    (item) => Boolean(item?.company && item?.role)
  );
}

/** Append-only merge for existing candidates — never overwrite recruiter-entered rows. */
export function mergePublicApplyQualifications(existing = [], incoming = []) {
  return appendUniquePublicApplyRows(
    existing,
    incoming,
    qualificationDedupeKey,
    (item) => Boolean(item?.degree && item?.institute)
  );
}

/** Append-only merge for existing candidates — never overwrite recruiter-entered rows. */
export function mergePublicApplySocialLinks(existing = [], incoming = []) {
  return appendUniquePublicApplyRows(
    existing,
    incoming,
    socialLinkDedupeKey,
    (item) => Boolean(item?.url)
  );
}

function parsedJsonToPublicProfileArrays(parsed) {
  const experiences = normalizePublicApplyExperiences(parsed.experiences);
  const qualifications = normalizePublicApplyQualifications(parsed.qualifications);
  const socialLinks = normalizePublicApplySocialLinks(parsed.socialLinks);
  return { experiences, qualifications, socialLinks };
}

function serializePublicDateForResponse(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function computePublicParseStatus(fields) {
  const hasName = Boolean(fields.fullName);
  const hasEmail = Boolean(fields.email);
  const hasPhone = Boolean(fields.phoneNumber);
  const hasSkills = Array.isArray(fields.skills) && fields.skills.length > 0;
  const coreCount = [hasName, hasEmail, hasPhone].filter(Boolean).length;
  if (coreCount === 0 && !hasSkills) return 'failed';
  if (coreCount >= 2 || (coreCount >= 1 && hasSkills)) return 'success';
  return 'partial';
}

function parseSkillItem(item) {
  if (typeof item === 'string') return { name: item.trim().replace(/\s+/g, ' '), level: null };
  if (item && typeof item === 'object') {
    const name = String(item.name ?? item.skill ?? '').trim().replace(/\s+/g, ' ');
    const rawLevel = String(item.level ?? '');
    const normalized = rawLevel.charAt(0).toUpperCase() + rawLevel.slice(1).toLowerCase();
    const level = VALID_LEVELS.has(normalized) ? normalized : null;
    return { name, level };
  }
  return { name: '', level: null };
}

/**
 * Normalize client-supplied skills from public apply (JSON string or array).
 * Invalid level values are coerced to Intermediate so Employee.create cannot fail validation.
 * @param {unknown} raw
 * @returns {Array<{ name: string; level: string; category?: string; source: string }>}
 */
export function normalizePublicApplySkills(raw) {
  if (raw == null) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set();
  const skills = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { name, level } = parseSkillItem(item);
    const trimmedName = trimPublicString(name, MAX_PUBLIC_SKILL_NAME);
    if (!trimmedName) continue;
    const dedupeKey = trimmedName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const category = item.category ? trimPublicString(item.category, MAX_PUBLIC_SHORT_STRING) : undefined;
    skills.push({
      name: trimmedName,
      level: level || 'Intermediate',
      ...(category ? { category } : {}),
      source: 'resume',
    });
    if (skills.length >= MAX_PUBLIC_SKILLS) break;
  }
  return skills;
}

/**
 * Flatten categorized skill arrays into Employee.skill schema rows (dedupe by case-insensitive name).
 * Accepts both string[] and {name, level}[] per bucket.
 * @param {Record<string, unknown>} parsed - Parsed JSON from model
 * @param {{ source?: string }} [opts]
 * @returns {{ skills: Array<{ name: string; level: string; category?: string; source?: string }>; buckets: Record<string, string[]> }}
 */
export function categorizedJsonToEmployeeSkills(parsed, opts = {}) {
  const source = opts.source || 'manual';
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
  /** @type {Array<{ name: string; level: string; category?: string; source?: string }>} */
  const skills = [];
  const seen = new Set();

  for (const [key, categoryLabel] of pairs) {
    const raw = parsed[key];
    const arr = Array.isArray(raw) ? raw : [];
    buckets[key] = [];
    for (const item of arr) {
      const { name, level } = parseSkillItem(item);
      if (!name) continue;
      buckets[key].push(name);
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      skills.push({
        name,
        level: level || 'Intermediate',
        category: categoryLabel,
        source,
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
  const text = await readResumeTextFromBuffer(buffer, mimeType, filename);

  const client = getOpenAIClient();
  const model = DEFAULT_MODEL;

  const system = `You extract structured skills from resume text. Reply with a single JSON object only (no markdown).
Keys: name (string, candidate display name or empty), technical, soft, tools, languages, domains, certifications.
Each bucket is an array of objects: {name: string, level: string}.
level must be one of: Beginner, Intermediate, Advanced, Expert — infer from resume context (years of experience, explicit claims, project depth).
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

  const out = categorizedJsonToEmployeeSkills(parsed, { source: 'resume' });
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
export async function recommendSkillsForJobRole(roleTitle, currentSkillsRaw = [], seniorityRaw = '') {
  const trimmed = String(roleTitle || '')
    .trim()
    .slice(0, 500);
  if (!trimmed || trimmed.length < 2) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Enter a job role (at least 2 characters).');
  }

  const seniority = String(seniorityRaw || '').trim().slice(0, 50);

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
Keys: technical, soft, tools, languages, domains, certifications.
Each bucket is an array of objects: {name: string, level: string}.
level is the target proficiency to reach: Beginner, Intermediate, Advanced, or Expert — pick based on what this role AND seniority typically requires.
technical = stacks still missing or weak for this role vs what they already have.
soft = interpersonal skills worth developing for this role.
tools = products/platforms to learn.
languages = spoken languages if relevant.
domains = industries or contexts to deepen.
certifications = credentials worth pursuing.

SENIORITY GUIDANCE: When a seniority level is given, calibrate skill depth and breadth accordingly:
- Junior/Entry: foundational skills, common tools, basic best practices; lean toward Beginner/Intermediate levels.
- Mid-level: solid breadth, independent execution, applied best practices; Intermediate/Advanced levels.
- Senior: deep expertise, system design, mentoring, cross-functional skills; mostly Advanced.
- Lead/Staff/Principal: architecture, technical strategy, large-scope influence, advanced soft skills (mentoring, stakeholder mgmt); Advanced/Expert.
- Manager/Director: people management, hiring, roadmap ownership, exec communication, budget/strategy; Advanced/Expert in leadership-oriented skills.

IMPORTANT: The user lists skills the employee ALREADY has. Recommend ONLY additional skills they still need to develop for the target role at the given seniority. Do NOT repeat or trivially rename existing skills (match names loosely; ignore case). If they already cover the role well, use mostly empty arrays with a few high-impact gaps only.

Emit roughly 8–24 NEW distinct skill names total across buckets (fewer if redundant). Empty arrays allowed.`;

  const roleLine = seniority ? `${seniority} ${trimmed}` : trimmed;
  const seniorityLine = seniority ? `\nSeniority level: ${seniority}` : '';
  const user = `Target job role:\n${roleLine}${seniorityLine}\n\nSkills the employee already has:\n${skillsLines}\n\nWhat additional skills should they develop for this role at this seniority? JSON only.`;

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

  const out = categorizedJsonToEmployeeSkills(parsed, { source: 'ai_recommended' });
  const existingLower = new Set(currentSkills.map((s) => String(s.name).trim().toLowerCase()).filter(Boolean));
  const filteredSkills = out.skills.filter(
    (sk) => !existingLower.has(String(sk.name || '').trim().toLowerCase())
  );

  logger.info(
    '[resumeSkillsExtract] recommend-by-role count=%s afterDedupe=%s model=%s roleLen=%s existing=%s seniority=%s',
    out.skills.length,
    filteredSkills.length,
    completion.model || model,
    trimmed.length,
    currentSkills.length,
    seniority || '-'
  );
  return { skills: filteredSkills, buckets: out.buckets };
}

/**
 * Parse a public-apply resume for contact fields + skills. Does not persist raw resume text.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<{ status: 'success'|'partial'|'failed'; warnings: string[]; fields: { fullName: string|null; email: string|null; phoneNumber: string|null; countryCode: string|null; skills: Array<{ name: string; level: string; category?: string }>; experiences: Array<object>; qualifications: Array<object>; socialLinks: Array<object> } }>}
 */
export async function parseResumeForPublicApply(buffer, mimeType, filename) {
  const warnings = [];
  const emptyFields = {
    fullName: null,
    email: null,
    phoneNumber: null,
    countryCode: null,
    skills: [],
    experiences: [],
    qualifications: [],
    socialLinks: [],
  };

  let text;
  try {
    text = await readResumeTextFromBuffer(buffer, mimeType, filename);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : 'Could not read resume text.';
    return { status: 'failed', warnings: [message], fields: emptyFields };
  }

  let client;
  try {
    client = getOpenAIClient();
  } catch (e) {
    const message = e instanceof ApiError ? e.message : 'Resume parsing is temporarily unavailable.';
    return { status: 'failed', warnings: [message], fields: emptyFields };
  }

  const model = DEFAULT_MODEL;
  const system = `You extract candidate profile details from resume text. Reply with ONE JSON object only (no markdown).
Keys:
- fullName (string, display name or empty)
- email (string or empty)
- phone (string, digits and optional + prefix, or empty)
- countryCode (ISO 3166-1 alpha-2 uppercase, e.g. US, IN, GB — infer from phone/address when possible, else empty)
- technical, soft, tools, languages, domains, certifications — each an array of {name: string, level: string}
- experiences — array of {company, role, startDate, endDate, currentlyWorking, description}
- qualifications — array of {degree, institute, location, startYear, endYear, description}
- socialLinks — array of {platform, url} for LinkedIn, GitHub, portfolio, etc.
level must be one of: Beginner, Intermediate, Advanced, Expert.
Use ISO dates (YYYY-MM-DD) when possible for experience dates; years only for qualification startYear/endYear.
Do not invent contact details not present in the resume. Empty strings and empty arrays are allowed.`;

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
    logger.error('[resumeSkillsExtract] public parse OpenAI error', { message: e?.message });
    return {
      status: 'failed',
      warnings: ['Resume parsing failed. You can fill in the form manually.'],
      fields: emptyFields,
    };
  }

  const rawJson = completion.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = parseJsonWithRepair(rawJson, 'public-resume-parse');
  } catch (e) {
    logger.warn('[resumeSkillsExtract] public parse JSON failed', { message: e?.message });
    return {
      status: 'failed',
      warnings: ['Could not interpret AI response. Fill in the form manually.'],
      fields: emptyFields,
    };
  }

  const skillOut = categorizedJsonToEmployeeSkills(parsed, { source: 'resume' });
  const profileArrays = parsedJsonToPublicProfileArrays(parsed);
  const countryCode = normalizeCountryCode(parsed.countryCode);
  const phoneNumber = normalizePhoneDigits(parsed.phone ?? parsed.phoneNumber, countryCode);
  const email = normalizeEmail(parsed.email);
  const fullName = normalizeFullName(parsed.fullName ?? parsed.name);

  if (!fullName) warnings.push('Full name could not be detected — please enter it manually.');
  if (!email) warnings.push('Email could not be detected — please enter it manually.');
  if (!phoneNumber) warnings.push('Phone number could not be detected — please enter it manually.');
  if (skillOut.skills.length === 0) warnings.push('No skills detected — you can still submit your application.');
  if (profileArrays.experiences.length === 0) {
    warnings.push('No work experience detected — you can add it manually before submitting.');
  }
  if (profileArrays.qualifications.length === 0) {
    warnings.push('No qualifications detected — you can add them manually before submitting.');
  }

  const fields = {
    fullName,
    email,
    phoneNumber,
    countryCode,
    skills: skillOut.skills.map(({ name, level, category }) => ({ name, level, category })),
    experiences: profileArrays.experiences.map((item) => ({
      company: item.company,
      role: item.role,
      startDate: serializePublicDateForResponse(item.startDate),
      endDate: serializePublicDateForResponse(item.endDate),
      currentlyWorking: Boolean(item.currentlyWorking),
      description: item.description || null,
    })),
    qualifications: profileArrays.qualifications.map((item) => ({
      degree: item.degree,
      institute: item.institute,
      location: item.location || null,
      startYear: item.startYear ?? null,
      endYear: item.endYear ?? null,
      description: item.description || null,
    })),
    socialLinks: profileArrays.socialLinks.map((item) => ({
      platform: item.platform,
      url: item.url,
    })),
  };

  const status = computePublicParseStatus(fields);
  logger.info(
    '[resumeSkillsExtract] public parse status=%s skills=%s experiences=%s qualifications=%s socialLinks=%s model=%s',
    status,
    fields.skills.length,
    fields.experiences.length,
    fields.qualifications.length,
    fields.socialLinks.length,
    completion.model || model
  );

  return { status, warnings, fields };
}
