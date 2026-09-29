import Joi from 'joi';
import { getJobs } from '../../../../../validations/job.validation.js';
import { EXTERNAL_JOB_SOURCES } from '../../../../../models/externalJob.model.js';

// Keys the ATS Jobs page's own GET /jobs query also accepts reuse that route's Joi
// piece, so the chat accepts exactly the values the page does. The rest are either
// Sage-only (company/city/remote/skill have no page equivalent) or written locally
// because the page's version uses Joi features the tool schema converter rejects
// (postingDate's .pattern(), jobOrigin's .allow('', null), salaryNotSpecified's
// "true"/"false" strings).
const page = (key) => getJobs.query.extract(key);

/**
 * The one `filters` object every job tool takes. Meanings match fetch_jobs'
 * parameter descriptions (chatAssistant.service.js ROUTING_TOOLS) and are applied by
 * buildJobRankingMongoFilter (queryPlanner/entities/jobRank.js).
 */
export const filters = Joi.object({
  search: Joi.alternatives()
    .try(Joi.string().min(1), Joi.array().items(Joi.string().min(1)).max(10))
    .description(
      'Matches title, company, description, location and skill tags — like the Jobs page search box. ' +
        'Use for topics like "AI", "sales", "react developer". Pass an array to match ANY of several ' +
        'topics: "ml and ai jobs" → ["ml", "ai"].',
    ),
  searchAll: Joi.array()
    .items(Joi.string().min(1))
    .max(6)
    .description(
      'Like search, but a job must match EVERY term: "react and node jobs" → ["react", "node"]. ' +
        'Use for a tech stack\'s core parts: MERN → ["react", "node"].',
    ),
  status: page('status').description(
    'Defaults to Active, like the Jobs page. Pass "all" only when the user asks for every status ' +
      '(e.g. "all statuses", "including closed", "ever posted").',
  ),
  jobType: page('jobType').description('Filter by type.'),
  jobOrigin: Joi.string()
    .valid('internal', 'external')
    .description('Filter by origin: "internal" (company-posted) or "external" (mirrored listing). Omit for both.'),
  externalSource: Joi.alternatives()
    .try(
      Joi.string().valid(...EXTERNAL_JOB_SOURCES),
      Joi.array().items(Joi.string().valid(...EXTERNAL_JOB_SOURCES)).max(EXTERNAL_JOB_SOURCES.length),
    )
    .description('Only mirrored external listings from this feed. "LinkedIn jobs" = both linkedin-* feeds as an array.'),
  company: Joi.string().min(1).description('Filter by organisation name (partial match).'),
  location: page('location').description('Filter by location (partial match).'),
  city: Joi.string().min(1).description('Filter by city (partial match on the location text).'),
  remote: Joi.boolean().description('Only remote jobs.'),
  skill: Joi.string().min(1).description('Filter by required skill tag (e.g. "React", "Python").'),
  experienceLevel: page('experienceLevel').description('Filter by level.'),
  experienceMin: page('experienceMin').description('Minimum years of experience.'),
  experienceMax: page('experienceMax').description('Maximum years of experience.'),
  salaryMin: page('salaryMin').description('Minimum salary.'),
  salaryMax: page('salaryMax').description('Maximum salary.'),
  salaryNotSpecified: Joi.boolean().description('Only jobs with no salary specified.'),
  postingDate: Joi.string().description('Jobs posted on this date (YYYY-MM-DD).'),
}).description('Job filters. Omit a key to leave it unfiltered; status defaults to Active.');

/**
 * Status defaults to Active, like the Jobs page. The one exception is a breakdown BY
 * status: defaulting there would collapse it to a single "Active" row, so it covers
 * every status unless the user named one.
 * @param {object} [f]
 * @param {{ groupBy?: string }} [opts]
 */
export function withDefaultStatus(f = {}, { groupBy } = {}) {
  if (f.status) return { ...f };
  return { ...f, status: groupBy === 'status' ? 'all' : 'Active' };
}
