/**
 * Canonical Job schema → Sage label registry.
 * Only fields that exist on job.model.js — used by profile renderer + filter builder.
 */

/** @typedef {{ path?: string, derive?: string, label: string, summary?: boolean, filterKey?: string }} JobFieldDecl */

/** @type {Record<string, Record<string, JobFieldDecl>>} */
export const JOB_FIELDS = Object.freeze({
  identity: {
    title: { path: 'title', label: 'Title', summary: true },
    jobType: { path: 'jobType', label: 'Type', summary: true },
    status: { path: 'status', label: 'Status', summary: true },
    jobOrigin: { path: 'jobOrigin', label: 'Origin' },
  },
  organisation: {
    company: { path: 'organisation.name', label: 'Company', summary: true },
    companyWebsite: { path: 'organisation.website', label: 'Website' },
    companyIndustry: { path: 'organisation.industry', label: 'Industry' },
    companySize: { path: 'organisation.companySize', label: 'Company size' },
  },
  location: {
    location: { path: 'location', label: 'Location', summary: true },
  },
  compensation: {
    salaryRange: { path: 'salaryRange', label: 'Salary', summary: true, filterKey: 'salaryMin' },
  },
  requirements: {
    experienceLevel: { path: 'experienceLevel', label: 'Experience level', summary: true },
    minExperience: { path: 'minExperience', label: 'Min experience (years)', filterKey: 'experienceMin' },
    maxExperience: { path: 'maxExperience', label: 'Max experience (years)', filterKey: 'experienceMax' },
    skillTags: { path: 'skillTags', label: 'Skills', summary: true, filterKey: 'skill' },
    jobDescription: { path: 'jobDescription', label: 'Description' },
    vacancies: { path: 'vacancies', label: 'Openings', summary: true },
  },
  external: {
    externalPlatformUrl: { path: 'externalPlatformUrl', label: 'Source URL' },
  },
});

/** Flat map: Sage key → declaration (for single-fact lookup). */
export const JOB_FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(
    Object.values(JOB_FIELDS).flatMap((section) =>
      Object.entries(section).map(([key, decl]) => [key, { ...decl, key }]),
    ),
  ),
);

/** Schema paths that exist on Job — for test parity checks. */
export const JOB_SCHEMA_PATHS = Object.freeze([
  'title',
  'jobDescription',
  'jobType',
  'location',
  'skillTags',
  'skillRequirements',
  'salaryRange',
  'salaryRange.min',
  'salaryRange.max',
  'salaryRange.currency',
  'experienceLevel',
  'minExperience',
  'maxExperience',
  'vacancies',
  'status',
  'jobOrigin',
  'organisation.name',
  'organisation.website',
  'organisation.email',
  'organisation.phone',
  'organisation.address',
  'organisation.description',
  'organisation.industry',
  'organisation.founded',
  'organisation.companySize',
  'externalRef.externalId',
  'externalRef.source',
  'externalPlatformUrl',
  'createdAt',
  'updatedAt',
]);

/** UI labels sometimes referenced but absent from schema — do not invent filters. */
export const JOB_DEFERRED_FIELDS = Object.freeze([
  'educationRequirements',
  'requirements', // no dedicated field; use jobDescription + skillRequirements
  'department', // not on Job model (filter uses title/description heuristics)
]);

/**
 * Read a dotted path from a job document.
 * @param {object|null} doc
 * @param {string} path
 */
export function readJobPath(doc, path) {
  if (!doc || !path) return null;
  const parts = path.split('.');
  let cur = doc;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur ?? null;
}

/**
 * Project registered fields from a job document for profile rendering.
 * @param {object} doc
 * @returns {Record<string, unknown>}
 */
export function projectJobFields(doc) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const section of Object.values(JOB_FIELDS)) {
    for (const [key, decl] of Object.entries(section)) {
      if (!decl.path) continue;
      const val = readJobPath(doc, decl.path);
      if (val != null && val !== '') out[key] = val;
    }
  }
  return out;
}

/** @param {object} fields */
export function formatJobSalaryRange(fields) {
  const sr = fields?.salaryRange;
  if (!sr || typeof sr !== 'object') return null;
  const min = sr.min ?? null;
  const max = sr.max ?? null;
  const cur = sr.currency || '';
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${cur}${min}–${max}`.trim();
  return `${cur}${min ?? max}`.trim();
}

/** @param {object} fields */
export function formatJobExperience(fields) {
  const min = fields?.minExperience;
  const max = fields?.maxExperience;
  if (min != null && max != null) return `${min}–${max} years`;
  if (min != null) return `${min}+ years`;
  if (max != null) return `Up to ${max} years`;
  return fields?.experienceLevel ?? null;
}

/** Summary field keys for brief profile turns. */
export const JOB_SUMMARY_KEYS = Object.freeze(
  Object.entries(JOB_FIELD_BY_KEY)
    .filter(([, d]) => d.summary)
    .map(([k]) => k),
);
