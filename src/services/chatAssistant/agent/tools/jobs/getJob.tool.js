import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { fetchJobById, resolveJobByTitle } from '../../../jobProfile/resolveJobByTitle.js';
import { renderJobs } from '../../../renderers/jobs.js';
import { JOBS_ACCESS, jobScope } from './common.js';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
// The registry's size cap only shrinks top-level arrays, so a long description on
// the single `job` object would reach the model uncut; bound it here.
export const MAX_DESCRIPTION_CHARS = 4000;

/** @param {object} job - mapJobRow row */
function boundDescription(job) {
  const text = job.jobDescription;
  if (typeof text !== 'string' || text.length <= MAX_DESCRIPTION_CHARS) return job;
  return { ...job, jobDescription: text.slice(0, MAX_DESCRIPTION_CHARS), descriptionTruncated: true };
}

export default defineTool({
  name: 'get_job',
  domain: 'jobs',
  kind: 'read',
  description:
    'Full detail of one job posting (description, skills, salary, experience, openings, link) by id or ' +
    'title. A title that fits several jobs returns { matches } to ask the user which one.',
  input: Joi.object({
    jobId: Joi.string().description('Job id (jobId from an earlier list_jobs or rank_jobs_by_salary row).'),
    title: Joi.string().min(1).description('Job title or part of it, e.g. "senior react developer".'),
  }).or('jobId', 'title'),
  access: JOBS_ACCESS,
  async execute({ jobId, title } = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);

    // A malformed id would throw a CastError in findOne; treat it as not found.
    if (jobId && OBJECT_ID_RE.test(jobId)) {
      const found = await fetchJobById(jobId, { Job, visibilityFilter });
      if (found) return { job: boundDescription(found.job) };
    }
    if (!title) return { notFound: true };

    const resolved = await resolveJobByTitle(title, { Job, visibilityFilter });
    if (resolved.kind === 'unique') return { job: boundDescription(resolved.job) };
    // matches carry only jobId/title/company/location/score — no description to bound.
    if (resolved.kind === 'ambiguous') return { matches: resolved.matches };
    return { notFound: true };
  },
  render(result) {
    if (!result?.job) return null;
    // Same detail card the legacy job profile path shows (presentJobProfile → renderJobs).
    const rendered = renderJobs({ records: [result.job], wantDetail: true }, { listIntent: false }, null);
    return { blocks: rendered?.block ? [rendered.block] : [], facts: { counts: [], primary: null } };
  },
});
