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
    'breakdown by status. Use for "how many jobs has X applied to", "how many applications for job Y".',
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
