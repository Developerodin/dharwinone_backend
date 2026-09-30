import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { fetchJobById, resolveJobByTitle } from '../../../jobProfile/resolveJobByTitle.js';
import { renderJobs } from '../../../renderers/jobs.js';
import { formatSalaryRange } from '../../../jobFieldMap.js';
import { JOBS_ACCESS, NOT_CAPTURED, jobScope, fetchJobOwnership } from './common.js';

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

/**
 * The salary as the Jobs page Salary column reads it: no range, or 0 – 0, is "Not specified"
 * (jobMappers.ts formatSalaryRange). The page shows salary to every jobs.read viewer, so nothing is redacted.
 */
export function payLabel(salaryRange) {
  const { min, max } = salaryRange || {};
  if (!min && !max) return 'Not specified';
  return formatSalaryRange(salaryRange);
}

/**
 * Adds pay, creator, recruiter and deadline. Job (models/job.model.js) and the job validation have no
 * project, visa, sponsorship or work-authorization field, so those are null and said to be not captured.
 */
async function detail(job, Job, visibilityFilter) {
  const own = await fetchJobOwnership(Job, visibilityFilter, job.jobId);
  return {
    ...boundDescription(job),
    pay: payLabel(job.salaryRange),
    createdBy: own.createdBy,
    recruiter: own.recruiter,
    // mapJobRow's recruiterName reads a populated assignedRecruiter the profile select never loads.
    recruiterName: own.recruiter,
    ...(own.recruiter ? {} : { recruiterNote: 'No recruiter assigned — the job creator approves interview times.' }),
    applicationDeadline: own.applicationDeadline,
    project: null,
    workAuthorization: null,
    notCaptured: `Project and visa / work authorization are ${NOT_CAPTURED} for jobs.`,
  };
}

export default defineTool({
  name: 'get_job',
  domain: 'jobs',
  kind: 'read',
  description:
    'Full detail of one job posting (description, skills, salary as the Jobs page shows it, experience, openings, ' +
    'application deadline, who created it, assigned recruiter, link) by id or title. A title that fits several ' +
    'jobs returns { matches } to ask the user which one. Jobs have no project or visa / work-authorization field.',
  input: Joi.object({
    jobId: Joi.string().description('Job id (jobId from an earlier list_jobs or rank_jobs_by_salary row).'),
    title: Joi.string().min(1).max(200).description('Job title or part of it, e.g. "senior react developer".'),
  }).or('jobId', 'title'),
  access: JOBS_ACCESS,
  async execute({ jobId, title } = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);

    // A malformed id would throw a CastError in findOne; treat it as not found.
    if (jobId && OBJECT_ID_RE.test(jobId)) {
      const found = await fetchJobById(jobId, { Job, visibilityFilter });
      if (found) return { job: await detail(found.job, Job, visibilityFilter) };
    }
    if (!title) return { notFound: true };

    const resolved = await resolveJobByTitle(title, { Job, visibilityFilter });
    if (resolved.kind === 'unique') return { job: await detail(resolved.job, Job, visibilityFilter) };
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
