import { bolnaJobContextFromDoc } from './jobBolnaContext.js';
import { emailToSpokenForm } from './emailToSpokenForm.js';

/** Keep prompts within reasonable size; full text still passed in user_data when shorter. */
const MAX_JOB_DESCRIPTION_IN_PROMPT = 14000;
const MAX_JOB_DESCRIPTION_IN_USERDATA = 32000;

function fmtDate(value) {
  if (value == null) return '';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(value);
  }
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n[Truncated — original length ${s.length} characters.]`, truncated: true };
}

function templateIdString(job) {
  const t = job.templateId;
  if (t == null) return '';
  if (typeof t === 'object' && t._id != null) return String(t._id);
  return String(t);
}

function templateSummary(job) {
  const t = job.templateId;
  if (t == null) return null;
  if (typeof t === 'object' && (t.name || t.description)) {
    const parts = [t.name && `Template name: ${t.name}`, t.description && `Template notes: ${t.description}`].filter(Boolean);
    return parts.join('\n');
  }
  return `Template id: ${templateIdString(job)}`;
}

function createdBySummary(job) {
  const u = job.createdBy;
  if (u == null) return null;
  if (typeof u === 'object' && u.name) {
    return `Listing owner (platform): ${u.name}${u.email ? ` (${u.email})` : ''}`;
  }
  return `Listing owner user id: ${String(u)}`;
}

/**
 * Full job snapshot for job-posting verification (prompt + Bolna user_data).
 * @param {Object} job - Mongoose doc or plain object
 */
export function buildJobPostingVerificationKnowledge(job) {
  if (!job) {
    return {
      knowledgeBlock: '(No job data.)',
      userData: { call_type: 'job_posting_verification' },
    };
  }

  const org = job.organisation || {};
  const sr = job.salaryRange || {};
  const ctx = bolnaJobContextFromDoc(job);
  const rawDesc = String(job.jobDescription || '').trim();
  const promptDesc = truncate(rawDesc, MAX_JOB_DESCRIPTION_IN_PROMPT);
  const userDataDesc = truncate(rawDesc, MAX_JOB_DESCRIPTION_IN_USERDATA);

  const skillTags = Array.isArray(job.skillTags) ? job.skillTags.filter(Boolean) : [];
  const ext = job.externalRef || {};

  const salaryNumeric =
    sr.min != null || sr.max != null
      ? JSON.stringify({ min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency || 'USD' })
      : '';

  const knowledgeBlock = [
    '=== COMPLETE JOB LISTING (use this to verify details with the contact) ===',
    '',
    'SCOPE (read carefully): Organisation fields below describe the EMPLOYER who posted the job on Dharwin.',
    'They are third-party listing facts. They are NOT your identity and NOT your employer.',
    'You represent only the Dharwin platform when speaking.',
    '',
    '--- Organisation ---',
    `Name: ${org.name || 'Not specified'}`,
    `Website: ${org.website || 'Not provided'}`,
    `Public / listing email (symbols; do not read this line aloud): ${org.email || 'Not provided'}`,
    org.email
      ? `Say this listing email aloud using only these words (TTS): ${emailToSpokenForm(org.email)}`
      : null,
    `Address: ${org.address || 'Not provided'}`,
    org.description ? `Organisation description: ${org.description}` : null,
    '(You are calling the organisation phone on file. Do not read their phone number aloud unless they ask.)',
    '',
    '--- Role ---',
    `Job title: ${job.title || ''}`,
    `Job type: ${job.jobType || 'Not specified'}`,
    `Location: ${job.location || 'Not specified'}`,
    `Experience level: ${job.experienceLevel || 'Not specified'}`,
    `Listing status on platform: ${job.status || 'Not specified'}`,
    `Salary (spoken-friendly): ${ctx.salaryRange || 'Not specified'}`,
    salaryNumeric ? `Salary (structured): ${salaryNumeric}` : null,
    skillTags.length ? `Skill tags: ${skillTags.join(', ')}` : 'Skill tags: (none listed)',
    `Job origin: ${job.jobOrigin || 'internal'}`,
    ext.externalId || ext.source
      ? `External reference: source=${ext.source || ''}, id=${ext.externalId || ''}`
      : null,
    job.externalPlatformUrl ? `External platform URL: ${job.externalPlatformUrl}` : null,
    `Posted (created): ${fmtDate(job.createdAt)}`,
    `Last updated: ${fmtDate(job.updatedAt)}`,
    createdBySummary(job),
    templateSummary(job),
    '',
    '--- Full job description ---',
    promptDesc.text,
    '',
    promptDesc.truncated
      ? 'Part of the description was truncated above; the field user_data.job_description may contain more.'
      : null,
  ]
    .filter((line) => line != null && line !== '')
    .join('\n');

  const userData = {
    call_type: 'job_posting_verification',
    contact_role: 'recruiter_or_hr',
    job_id: job._id != null ? String(job._id) : undefined,
    organisation_name: org.name || '',
    organisation_website: org.website || '',
    organisation_email: org.email || '',
    organisation_address: org.address || '',
    organisation_description: org.description || '',
    job_title: job.title || '',
    job_type: job.jobType || '',
    job_location: job.location || '',
    experience_level: job.experienceLevel || '',
    salary_range_spoken: ctx.salaryRange || '',
    salary_min: sr.min != null ? String(sr.min) : '',
    salary_max: sr.max != null ? String(sr.max) : '',
    salary_currency: sr.currency || '',
    skill_tags: skillTags.join(', '),
    job_description: userDataDesc.text,
    job_description_was_truncated: userDataDesc.truncated ? 'true' : 'false',
    listing_status: job.status || '',
    job_origin: job.jobOrigin || 'internal',
    external_source: ext.source || '',
    external_id: ext.externalId || '',
    external_platform_url: job.externalPlatformUrl || '',
    posted_date: fmtDate(job.createdAt),
    updated_date: fmtDate(job.updatedAt),
    template_id: templateIdString(job),
    template_name:
      typeof job.templateId === 'object' && job.templateId?.name ? String(job.templateId.name) : '',
    template_description:
      typeof job.templateId === 'object' && job.templateId?.description
        ? String(job.templateId.description).slice(0, 4000)
        : '',
    listing_owner_name:
      typeof job.createdBy === 'object' && job.createdBy?.name ? String(job.createdBy.name) : '',
    listing_owner_email:
      typeof job.createdBy === 'object' && job.createdBy?.email ? String(job.createdBy.email) : '',
  };

  Object.keys(userData).forEach((k) => {
    if (userData[k] === '' || userData[k] === undefined) delete userData[k];
  });

  return { knowledgeBlock, userData };
}
