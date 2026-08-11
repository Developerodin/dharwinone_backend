import {
  projectJobFields,
  formatJobSalaryRange,
  formatJobExperience,
  JOB_SUMMARY_KEYS,
  JOB_FIELD_BY_KEY,
} from '../jobFieldMap.js';
import { renderJobs } from '../renderers/jobs.js';
import { writeEntitySubject, subjectFromJob } from '../conversationState/entitySubject.js';
import { detectJobFollowUpIntent } from './detectJobQuery.js';

function formatFieldValue(key, fields) {
  if (key === 'salaryRange') return formatJobSalaryRange(fields);
  if (key === 'minExperience' || key === 'maxExperience' || key === 'experienceLevel') {
    return formatJobExperience(fields);
  }
  if (key === 'skillTags' && Array.isArray(fields.skillTags)) {
    return fields.skillTags.join(', ');
  }
  if (key === 'company') return fields.company ?? null;
  const val = fields[key];
  if (val == null || val === '') return null;
  if (typeof val === 'object' && val.name) return String(val.name);
  return String(val);
}

function jobFieldSentence(key, val, title) {
  const label = JOB_FIELD_BY_KEY[key]?.label?.toLowerCase() || key;
  if (key === 'salaryRange') return `The salary range is ${val}.`;
  if (key === 'vacancies') {
    const n = Number(val);
    return n === 1
      ? `There is **1** opening for **${title}**.`
      : `There are **${n}** openings for **${title}**.`;
  }
  if (key === 'skillTags') return `Required skills include ${val}.`;
  if (key === 'location') return `It's based in ${val}.`;
  if (key === 'company') return `It's posted by **${val}**.`;
  return `The ${label} is ${val}.`;
}

/**
 * Natural-language job profile summary (not a raw dump).
 * @param {{ job: object, fields: object, depth?: 'brief'|'full' }} input
 */
export function renderJobProfileSummary({ job, fields, depth = 'brief' }) {
  const title = job.title || 'This job';
  const parts = [];

  const company = formatFieldValue('company', fields);
  const type = formatFieldValue('jobType', fields);
  const loc = formatFieldValue('location', fields);

  if (company && type && loc) {
    parts.push(`**${title}** is a ${type} role at **${company}**, based in ${loc}.`);
  } else if (company) {
    parts.push(`**${title}** is listed at **${company}**.`);
  } else {
    parts.push(`Here's what I know about **${title}**.`);
  }

  const keys = depth === 'full'
    ? Object.keys(JOB_FIELD_BY_KEY)
    : JOB_SUMMARY_KEYS.filter((k) => !['title', 'jobType', 'location', 'company'].includes(k));

  for (const k of keys) {
    const val = formatFieldValue(k, fields);
    if (!val) continue;
    parts.push(jobFieldSentence(k, val, title));
  }

  if (depth === 'brief') {
    parts.push('Ask me about the salary, openings, skills, or full details.');
  }

  return parts.join(' ');
}

/**
 * @param {object} fields
 * @param {string|null} fieldKey
 * @param {string} title
 */
export function renderJobSingleFact(fields, fieldKey, title) {
  if (fieldKey === 'company') {
    const val = formatFieldValue('company', fields);
    return val
      ? `**${title}** is posted by **${val}**.`
      : `I don't have the company on file for **${title}**.`;
  }

  const val = formatFieldValue(fieldKey, fields);
  if (!val) {
    return `I don't have that detail for **${title}** right now.`;
  }
  return jobFieldSentence(fieldKey, val, title);
}

/**
 * @param {{ query: string, matches: object[] }} facts
 */
export function renderJobDisambiguation(facts) {
  const names = (facts.matches || []).map((m) => {
    const bits = [`**${m.title}**`];
    if (m.company) bits.push(`at ${m.company}`);
    if (m.location) bits.push(`(${m.location})`);
    return bits.join(' ');
  });
  if (names.length === 2) {
    return `Which job do you mean — ${names[0]} or ${names[1]}?`;
  }
  return `Which job do you mean — ${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}?`;
}

/**
 * Present a resolved job profile and persist entity subject for follow-ups.
 *
 * @param {{
 *   resolved: Awaited<ReturnType<import('./resolveJobByTitle.js').resolveJobByTitle>>,
 *   userMessage: string,
 *   userId: any,
 *   adminId: any,
 *   depth?: 'brief'|'full',
 *   deps?: object,
 * }} opts
 */
export async function presentJobProfile({
  resolved,
  userMessage,
  userId,
  adminId,
  depth = 'brief',
  deps = {},
}) {
  const writeSubject = deps.writeEntitySubject ?? writeEntitySubject;

  if (resolved.kind === 'notFound') {
    return {
      reply: `I couldn't find a job matching "${resolved.query}".`,
      blocks: [],
      meta: { kind: 'job_profile', entityType: 'job', deterministic: true },
    };
  }

  if (resolved.kind === 'ambiguous') {
    return {
      reply: renderJobDisambiguation(resolved),
      blocks: [],
      meta: { kind: 'job_disambiguation', entityType: 'job', deterministic: true },
      pendingJob: resolved,
    };
  }

  const fields = projectJobFields(resolved.raw || resolved.job);
  if (resolved.job?.organisation?.name) fields.company = resolved.job.organisation.name;

  const followUp = detectJobFollowUpIntent(userMessage, {
    entityType: 'job',
    jobId: resolved.job.jobId,
  });

  let reply;
  if (followUp.intent === 'single_fact' && followUp.field) {
    reply = renderJobSingleFact(fields, followUp.field, resolved.job.title);
  } else {
    reply = renderJobProfileSummary({ job: resolved.job, fields, depth });
  }

  const rendered = renderJobs(
    { records: [resolved.job], wantDetail: depth === 'full' },
    { listIntent: false },
    null,
  );

  const subject = subjectFromJob(resolved.job);
  if (userId && adminId && subject) {
    await writeSubject({ userId, adminId, subject, ...deps });
  }

  return {
    reply,
    blocks: rendered?.block ? [rendered.block] : [],
    meta: {
      kind: 'job_profile',
      entityType: 'job',
      jobId: resolved.job.jobId,
      deterministic: true,
    },
  };
}

/**
 * Follow-up on a stored job subject (salary, openings, etc.).
 *
 * @param {{
 *   job: object,
 *   raw?: object,
 *   userMessage: string,
 *   depth?: 'brief'|'full',
 * }} opts
 */
export function presentJobFollowUp({ job, raw = null, userMessage, depth = 'brief' }) {
  const fields = projectJobFields(raw || job);
  if (job?.organisation?.name) fields.company = job.organisation.name;

  const followUp = detectJobFollowUpIntent(userMessage, {
    entityType: 'job',
    jobId: job.jobId,
  });

  if (followUp.intent === 'single_fact' && followUp.field) {
    return {
      reply: renderJobSingleFact(fields, followUp.field, job.title),
      blocks: [],
      meta: { kind: 'job_profile', entityType: 'job', presentationIntent: 'single_fact', deterministic: true },
    };
  }

  if (followUp.intent === 'anything_else' || depth === 'full') {
    const rendered = renderJobs({ records: [job], wantDetail: true }, { listIntent: false }, null);
    return {
      reply: renderJobProfileSummary({ job, fields, depth: 'full' }),
      blocks: rendered?.block ? [rendered.block] : [],
      meta: { kind: 'job_profile', entityType: 'job', presentationIntent: 'full_profile', deterministic: true },
    };
  }

  return null;
}
