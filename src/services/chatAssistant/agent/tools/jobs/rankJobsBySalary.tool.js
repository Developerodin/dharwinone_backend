import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { executeRankQuery } from '../../../queryPlanner/executeRank.js';
import { ENTITY_JOB, JOB_SALARY_METRIC } from '../../../../../schemas/queryOperations.js';
import { filters, withDefaultStatus } from './filters.js';
import { JOBS_ACCESS, jobScope, jobRow } from './common.js';

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;

export default defineTool({
  name: 'rank_jobs_by_salary',
  domain: 'jobs',
  kind: 'read',
  description:
    'Highest- or lowest-paying job postings. Only jobs with a salary specified are ranked; total is how ' +
    'many of those match the filters.',
  input: Joi.object({
    filters,
    direction: Joi.string()
      .valid('desc', 'asc')
      .default('desc')
      .description('desc = highest-paying first (default), asc = lowest-paying first.'),
    limit: Joi.number()
      .integer()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .description(`How many jobs to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  }),
  access: JOBS_ACCESS,
  async execute({ filters: rawFilters, direction = 'desc', limit = DEFAULT_LIMIT } = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);
    const filtersApplied = withDefaultStatus(rawFilters);
    const ranked = await executeRankQuery(
      {
        entity: ENTITY_JOB,
        metric: JOB_SALARY_METRIC,
        direction,
        limit: Math.min(limit, MAX_LIMIT),
        filters: filtersApplied,
      },
      { Job, visibilityFilter },
    );
    return { total: ranked.total, direction, jobs: ranked.items.map(jobRow), filtersApplied };
  },
});
