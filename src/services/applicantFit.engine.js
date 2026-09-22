import crypto from 'crypto';
import {
  BIO_MAX_CHARS,
  COVER_LETTER_MAX_CHARS,
  CULTURAL_FIT_LABELS,
  EXPERIENCE_CAP,
  JD_MAX_CHARS,
  QUALIFICATION_CAP,
} from '../constants/applicantFit.js';
import { scoreSkillFit } from './hireForecast.fit.js';

/**
 * Pull a string id off a populated ref, ObjectId, or raw string.
 * @param {unknown} ref
 * @returns {string}
 */
export function extractRefId(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object') {
    return String(ref.id || ref._id || '');
  }
  return String(ref);
}

/**
 * Strip HTML tags from a job-description / bio string.
 * @param {unknown} value
 * @returns {string}
 */
export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncate plain text to a hard cap.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
export function truncateText(value, limit) {
  const plain = String(value ?? '').trim();
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Years between experience start and end (or now if currently working).
 * @param {{ startDate?: string|Date, endDate?: string|Date, currentlyWorking?: boolean }} exp
 * @returns {number|null}
 */
export function durationYearsOf(exp) {
  const start = exp?.startDate ? new Date(exp.startDate).getTime() : NaN;
  const endRaw = exp?.currentlyWorking || !exp?.endDate ? Date.now() : new Date(exp.endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(endRaw) || endRaw < start) return null;
  return Math.round(((endRaw - start) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
}

/**
 * Recruiter-facing success band from a 0–100 probability.
 * @param {number} pct
 * @returns {string}
 */
export function successLabelOf(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'Poor';
  if (n >= 80) return 'Strong';
  if (n >= 60) return 'Good';
  if (n >= 40) return 'Partial';
  return 'Poor';
}

/**
 * Recruiter-facing cultural-fit label.
 * @param {string} value
 * @returns {string}
 */
export function culturalLabelOf(value) {
  return CULTURAL_FIT_LABELS[value] || CULTURAL_FIT_LABELS.unclear;
}

/**
 * Stable cache key for a JD + skills + profile snapshot.
 * @param {object} parts
 * @returns {string}
 */
export function fitSignature(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Short heuristic rationale from skill overlap.
 * @param {{ fitScore: number, matchedSkills: object[], missingSkills: object[] }} skillFit
 * @returns {string}
 */
export function heuristicRationale(skillFit) {
  const matched = Array.isArray(skillFit?.matchedSkills) ? skillFit.matchedSkills.length : 0;
  const missing = Array.isArray(skillFit?.missingSkills) ? skillFit.missingSkills.length : 0;
  const total = matched + missing;
  if (total === 0) return 'No skill requirements on this job.';
  return `${matched}/${total} required skills matched.`;
}

/**
 * Normalize employee skills for prompts and signatures.
 * @param {Array<{ name?: string, level?: string }>} skills
 * @returns {Array<{ name: string, level: string }>}
 */
export function normalizeSkills(skills) {
  return (skills || [])
    .map((skill) => ({
      name: String(skill?.name || '').trim(),
      level: String(skill?.level || '').trim(),
    }))
    .filter((skill) => skill.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Role + tenure only — never company name (PII-adjacent).
 * @param {Array<object>} experiences
 * @returns {Array<{ role: string, durationYears: number|null }>}
 */
export function summarizeExperiences(experiences) {
  return (experiences || []).slice(0, EXPERIENCE_CAP).map((exp) => ({
    role: String(exp?.role || '').trim(),
    durationYears: durationYearsOf(exp),
  })).filter((exp) => exp.role);
}

/**
 * Degree names only.
 * @param {Array<{ degree?: string }>} qualifications
 * @returns {string[]}
 */
export function summarizeQualifications(qualifications) {
  return (qualifications || [])
    .slice(0, QUALIFICATION_CAP)
    .map((row) => String(row?.degree || '').trim())
    .filter(Boolean);
}

/**
 * Build heuristic DTO + cache signature for one application row.
 * @param {object} app
 * @param {object|null} job
 * @param {object|null} employee
 * @returns {{ app: object, applicationId: string, signature: string, heuristic: object, prompt: object }}
 */
export function prepareApplicantFit(app, job, employee) {
  const applicationId = extractRefId(app);
  const jobId = extractRefId(job) || extractRefId(app?.job);
  const candidateId = extractRefId(employee) || extractRefId(app?.candidate);
  const skills = normalizeSkills(employee?.skills);
  const skillFit = scoreSkillFit(skills, job || {});
  const jdPlain = truncateText(stripHtml(job?.jobDescription), JD_MAX_CHARS);
  const shortBio = truncateText(stripHtml(employee?.shortBio), BIO_MAX_CHARS);
  const coverLetter = truncateText(stripHtml(app?.coverLetter), COVER_LETTER_MAX_CHARS);
  const experiences = summarizeExperiences(employee?.experiences);
  const qualifications = summarizeQualifications(employee?.qualifications);
  const skillTags = (job?.skillTags || []).map((tag) => String(tag || '').trim()).filter(Boolean);
  const skillRequirements = (job?.skillRequirements || []).map((req) => ({
    name: String(req?.name || '').trim(),
    level: req?.level || null,
    required: req?.required !== false,
  })).filter((req) => req.name);
  const signature = fitSignature({
    jobId,
    candidateId,
    title: job?.title || '',
    jd: jdPlain,
    skillTags,
    skillRequirements,
    skills,
    department: String(employee?.department || ''),
    designation: String(employee?.designation || ''),
    shortBio,
    experiences,
    qualifications,
    coverLetter,
  });
  const successProbability = Number(skillFit.fitScore) || 0;
  const heuristic = {
    successProbability,
    successLabel: successLabelOf(successProbability),
    culturalFit: 'unclear',
    culturalLabel: culturalLabelOf('unclear'),
    rationale: heuristicRationale(skillFit),
    source: 'heuristic',
  };
  const prompt = {
    title: job?.title || '',
    jd: jdPlain,
    skillTags,
    skillRequirements,
    experienceLevel: job?.experienceLevel || null,
    jobType: job?.jobType || null,
    location: job?.location || null,
    skills,
    department: String(employee?.department || '') || null,
    designation: String(employee?.designation || '') || null,
    shortBio: shortBio || null,
    experiences,
    qualifications,
    coverLetter: coverLetter || null,
    heuristicSuccess: successProbability,
    matchedSkills: (skillFit.matchedSkills || []).map((row) => row.name).filter(Boolean),
    missingSkills: (skillFit.missingSkills || []).map((row) => row.name).filter(Boolean),
  };
  return { app, applicationId, signature, heuristic, prompt };
}

/**
 * List-safe DTO. Never includes JD or PII.
 * @param {object} merged
 * @returns {object}
 */
export function toApplicantFitDto(merged) {
  return {
    successProbability: merged.successProbability,
    successLabel: merged.successLabel,
    culturalFit: merged.culturalFit,
    culturalLabel: merged.culturalLabel,
    rationale: merged.rationale,
    source: merged.source,
  };
}
