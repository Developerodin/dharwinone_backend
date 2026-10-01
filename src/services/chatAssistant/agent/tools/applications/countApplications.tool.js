import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { applicationFilters } from './filters.js';
import {
  APPLICATIONS_ACCESS, applicationsScope, applicationsDeps, runApplicationSearch, applicationCountFacts,
} from './common.js';

export default defineTool({
  name: 'count_applications',
  domain: 'applications',
  kind: 'read',
  description:
    'Count job applications, optionally for one applicant, one job, or one status. Also returns a ' +
    'breakdown by status. Use for "how many jobs has X applied to", "how many applications for job Y", ' +
    '"how many have been in this status more than N days" (filters.inStatusOverDays; statusAgeUnknown has ' +
    'no status history and is not counted) and "how many were screened but never interviewed" ' +
    '(filters.screenedNeverInterviewed; screeningUnknown is neither screened nor not screened).',
  measure:
    'Job application RECORDS (one per applicant per job) you are allowed to see, every application ' +
      'status unless filters.status is set; internal relay/test applicants excluded.',
  input: Joi.object({ filters: applicationFilters }),
  access: APPLICATIONS_ACCESS,
  async execute({ filters } = {}, ctx) {
    const user = applicationsScope(ctx);
    const deps = applicationsDeps(ctx);
    const { records, ...rest } = await runApplicationSearch({ filters, limit: 1, user, deps }); // count only — no rows
    return rest;
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: applicationCountFacts('count_applications', result.total) };
  },
});
