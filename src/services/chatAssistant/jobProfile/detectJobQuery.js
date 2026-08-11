// Detect job profile lookups and job-context follow-ups.

import {
  CONVERSATIONAL_OPENER,
  detectBareDeicticReference,
  extractEntityAfterDeicticReference,
  isBareDeictic,
  resolveEntityNameWithContext,
  stripLeadingDeictic,
} from '../conversationalEntity/deicticReference.js';

const COUNT_LIST_RE =
  /\b(how many|count|number of|total|list|show (?:me )?(?:all|every|each)|give me (?:all|every))\b/i;

const JOB_ABOUT_RE = new RegExp(
  `\\b${CONVERSATIONAL_OPENER}\\s+(?:the\\s+)?(.+?)\\s+(?:job|opening|position|posting|vacancy|role)\\b`,
  'i',
);

const JOB_ABOUT_SHORT_RE =
  /\b(?:tell me (?:everything |more )?about|what do you know about)\s+(?:the\s+)?(.+?)\s+(?:job|opening|position|posting)\b/i;

const JOB_FIELD_FOLLOWUP_RE =
  /\b(what(?:'s| is)|how many|tell me|show me|give me)\b/i;

/** @type {Record<string, RegExp>} */
export const JOB_FIELD_PATTERNS = Object.freeze({
  salaryRange: /\b(salary|compensation|pay|package|ctc|lpa)\b/i,
  vacancies: /\b(vacanc(?:y|ies)|opening|openings|how many openings|positions available)\b/i,
  location: /\b(location|where|remote|city|based)\b/i,
  jobType: /\b(job type|full[\s-]?time|part[\s-]?time|internship|contract)\b/i,
  skillTags: /\b(skill|skills|require|requirements)\b/i,
  experienceLevel: /\b(experience|years of experience|seniority)\b/i,
  status: /\b(status|active|closed|draft|archived)\b/i,
  company: /\b(company|organisation|organization|employer)\b/i,
  jobDescription: /\b(description|responsibilities|duties|about the role)\b/i,
});

/** Strip trailing punctuation / filler from an extracted title. */
export function cleanJobTitle(raw) {
  const title = stripLeadingDeictic(raw)
    .replace(/\?+$/, '')
    .replace(/\s+(please|thanks|thank you|job|opening|position|posting|vacancy|role)\.?$/i, '')
    .trim();

  if (!title || isBareDeictic(title)) return '';
  return title;
}

/**
 * @param {string} message
 * @param {{ name?: string|null, jobTitle?: string|null, designation?: string|null, entitySubject?: object|null }} [context]
 * @returns {{ title: string, reference?: string|null, fromContext?: boolean, needsContext?: boolean, intent: 'GET_JOB_DETAILS' } | { needsContext: true, reference?: string|null, intent: 'GET_JOB_DETAILS' } | null}
 */
export function detectJobProfileQuery(message, context = {}) {
  const text = String(message || '').trim();
  if (!text || COUNT_LIST_RE.test(text)) return null;

  const afterRef = extractEntityAfterDeicticReference(text);
  if (afterRef) {
    return {
      title: afterRef.entityName,
      reference: afterRef.reference,
      intent: 'GET_JOB_DETAILS',
    };
  }

  const bareRef = detectBareDeicticReference(text);
  if (bareRef) {
    const resolved = resolveEntityNameWithContext({
      reference: bareRef.reference,
      context,
    });
    if (resolved.needsContext) {
      return {
        needsContext: true,
        reference: resolved.reference,
        intent: 'GET_JOB_DETAILS',
      };
    }
    return {
      title: resolved.entityName,
      reference: resolved.reference,
      ...(resolved.fromContext ? { fromContext: true } : {}),
      intent: 'GET_JOB_DETAILS',
    };
  }

  const hit = text.match(JOB_ABOUT_RE) || text.match(JOB_ABOUT_SHORT_RE);
  if (!hit) return null;

  const resolved = resolveEntityNameWithContext({
    entityName: cleanJobTitle(hit[1]),
    reference: isBareDeictic(hit[1]?.trim()) ? 'this job' : null,
    context,
  });

  if (resolved.needsContext) {
    return {
      needsContext: true,
      reference: resolved.reference,
      intent: 'GET_JOB_DETAILS',
    };
  }

  return {
    title: resolved.entityName,
    ...(resolved.reference ? { reference: resolved.reference } : {}),
    ...(resolved.fromContext ? { fromContext: true } : {}),
    intent: 'GET_JOB_DETAILS',
  };
}

/**
 * @param {string} message
 * @param {{ entityType?: string, jobId?: string|null, name?: string|null }} subject
 * @returns {{ field: string|null, intent: 'single_fact'|'anything_else'|null }}
 */
export function detectJobFollowUpIntent(message, subject = {}) {
  if (subject?.entityType !== 'job' || !subject?.jobId) {
    return { field: null, intent: null };
  }

  const text = String(message || '').trim();
  if (!text) return { field: null, intent: null };

  if (/\b(anything else|what else|tell me more|know more|what more)\b/i.test(text)) {
    return { field: null, intent: 'anything_else' };
  }

  if (!JOB_FIELD_FOLLOWUP_RE.test(text)) {
    return { field: null, intent: null };
  }

  for (const [key, re] of Object.entries(JOB_FIELD_PATTERNS)) {
    if (re.test(text)) return { field: key, intent: 'single_fact' };
  }

  return { field: null, intent: null };
}

/**
 * @param {string|null} fieldKey
 * @returns {string|null}
 */
export function detectJobTargetField(message) {
  const text = String(message || '');
  for (const [key, re] of Object.entries(JOB_FIELD_PATTERNS)) {
    if (re.test(text)) return key;
  }
  return null;
}
