import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { applicationFilters } from './filters.js';
import {
  APPLICATIONS_ACCESS, MAX_LIST_LIMIT, applicationsScope, applicationsDeps,
  runApplicationSearch, applicationCountFacts,
} from './common.js';

export default defineTool({
  name: 'list_applications',
  domain: 'applications',
  kind: 'read',
  description:
    'List job applications with applicant, job title and status. Use for "which jobs has X applied to", ' +
    '"who applied to job Y". total is the full count even when fewer rows come back.',
  input: Joi.object({
    filters: applicationFilters,
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: APPLICATIONS_ACCESS,
  async execute({ filters, limit } = {}, ctx) {
    const user = applicationsScope(ctx);
    const deps = applicationsDeps(ctx);
    return runApplicationSearch({ filters, limit, user, deps });
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'application-list',
      tableType: 'application-list',
      title: `Applications (${result.total})`,
      columns: [
        { key: 'applicant', label: 'Applicant', priority: 'primary' },
        { key: 'job', label: 'Job', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
      ],
      rows: result.records.map((r) => ({ applicant: r.applicant ?? '—', job: r.job ?? '—', status: r.status ?? '—' })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: applicationCountFacts('list_applications', result.total) };
  },
});
