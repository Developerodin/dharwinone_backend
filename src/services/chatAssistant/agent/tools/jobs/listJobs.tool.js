import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { executeAtomicJobQuery, buildJobResultEnvelope } from '../../../jobResult.js';
import { scopeJobModel } from '../../../queryPlanner/entities/jobRank.js';
import { renderJobResult } from '../../../renderers/jobs.js';
import { filters, withDefaultStatus } from './filters.js';
import { JOBS_ACCESS, jobScope, jobRow, jobCountFacts } from './common.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export default defineTool({
  name: 'list_jobs',
  domain: 'jobs',
  kind: 'read',
  description:
    'List job postings on the ATS Jobs page, newest first, with the total that match. Returns compact ' +
    'rows (title, company, type, location, status, salary, link); use get_job for one job\'s full detail.',
  measure:
    'Job POSTINGS on the ATS Jobs page you can see; status Active unless filters.status is set.',
  input: Joi.object({
    filters,
    limit: Joi.number()
      .integer()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .description(`Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). total is always the full count.`),
  }),
  access: JOBS_ACCESS,
  async execute({ filters: rawFilters, limit = DEFAULT_LIMIT } = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);
    const filtersApplied = withDefaultStatus(rawFilters);
    const envelope = await executeAtomicJobQuery({
      filters: filtersApplied,
      limit: Math.min(limit, MAX_LIMIT),
      listIntent: true,
      JobModel: scopeJobModel(Job, visibilityFilter),
    });
    return { total: envelope.total, jobs: envelope.records.map(jobRow), filtersApplied };
  },
  render(result) {
    const envelope = buildJobResultEnvelope({
      filters: result.filtersApplied,
      total: result.total,
      records: result.jobs,
      intent: 'list',
    });
    const { block } = renderJobResult(envelope, { listIntent: true });
    return { blocks: block ? [block] : [], facts: jobCountFacts('list_jobs', result.total) };
  },
});
