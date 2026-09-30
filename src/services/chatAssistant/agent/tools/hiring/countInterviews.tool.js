import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { INTERVIEW_STATUSES, INTERVIEW_RESULTS } from '../../../../../constants/atsPipeline.js';
import {
  INTERVIEWS_ACCESS, hiringScope, hiringDeps, countByBuckets, hiringCountFacts,
} from './common.js';
import { interviewDetailFilters, interviewExtraClauses, countInterviewsWith } from './interviewDetail.js';

export default defineTool({
  name: 'count_interviews',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count ATS interviews (the Interviews page — never internal meetings), with a breakdown by status ' +
    '(scheduled/ended/cancelled) and by result (pending/selected/rejected). Use for "how many interviews ' +
    'today/this week", "how many candidates were selected", "interviews by <interviewer>", "interviews with no ' +
    'result yet" (filters.resultMissing), "panel clashes this week" (filters.overlapping).',
  measure:
    'Interview RECORDS (one per scheduled interview round) you are allowed to see on the Interviews page ' +
      '(interviews manage = all, read = your own); every status and result unless filtered. byStatus ignores ' +
      'filters.status and byResult ignores filters.result.',
  input: Joi.object({ filters: interviewDetailFilters }),
  access: INTERVIEWS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const { clauses } = await interviewExtraClauses(filters, user, deps);
    const count = (f) => countInterviewsWith(f, clauses, user, deps);
    const [total, byStatus, byResult] = await Promise.all([
      count(filters),
      countByBuckets((status) => count({ ...filters, status }), INTERVIEW_STATUSES),
      countByBuckets((result) => count({ ...filters, result }), INTERVIEW_RESULTS),
    ]);
    // Legacy rows with no interviewResult at all fall in no result bucket; say so rather than let buckets not add up.
    const resultNotSet = total - Object.values(byResult).reduce((a, b) => a + b, 0);
    return { total, byStatus, byResult, ...(resultNotSet > 0 ? { resultNotSet } : {}), filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: hiringCountFacts('count_interviews', 'interviews', result.total) };
  },
});
