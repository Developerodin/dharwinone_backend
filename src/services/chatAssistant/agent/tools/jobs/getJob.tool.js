import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { fetchJobById, resolveJobByTitle } from '../../../jobProfile/resolveJobByTitle.js';
import { JOBS_ACCESS, jobScope } from './common.js';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

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
      if (found) return { job: found.job };
    }
    if (!title) return { notFound: true };

    const resolved = await resolveJobByTitle(title, { Job, visibilityFilter });
    if (resolved.kind === 'unique') return { job: resolved.job };
    if (resolved.kind === 'ambiguous') return { matches: resolved.matches };
    return { notFound: true };
  },
});
