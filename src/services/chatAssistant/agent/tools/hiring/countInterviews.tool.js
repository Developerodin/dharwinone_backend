import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { INTERVIEW_STATUSES, INTERVIEW_RESULTS } from '../../../../../constants/atsPipeline.js';
import { interviewFilters } from './filters.js';
import {
  INTERVIEWS_ACCESS, hiringScope, hiringDeps, countInterviews, countByBuckets, hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'count_interviews',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count ATS interviews (the Interviews page — never internal meetings), with a breakdown by status ' +
    '(scheduled/ended/cancelled) and by result (pending/selected/rejected). Use for "how many interviews ' +
    'today/this week", "how many candidates were selected", "interviews by <interviewer>".',
  measure:
    'Interview RECORDS (one per scheduled interview round) you are allowed to see on the Interviews page ' +
      '(interviews manage = all, read = your own); every status and result unless filtered. byStatus ignores ' +
      'filters.status and byResult ignores filters.result.',
  input: Joi.object({ filters: interviewFilters }),
  access: INTERVIEWS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const [total, byStatus, byResult] = await Promise.all([
      countInterviews(filters, user, deps),
      countByBuckets((status) => countInterviews({ ...filters, status }, user, deps), INTERVIEW_STATUSES),
      countByBuckets((result) => countInterviews({ ...filters, result }, user, deps), INTERVIEW_RESULTS),
    ]);
    return { total, byStatus, byResult, filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: hiringCountFacts('count_interviews', 'interviews', result.total) };
  },
});
