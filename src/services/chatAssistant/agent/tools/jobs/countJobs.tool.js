import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  andMongoFilters,
  buildJobRankingMongoFilter,
  computeJobOriginCounts,
} from '../../../queryPlanner/entities/jobRank.js';
import { filters, withDefaultStatus } from './filters.js';
import { JOBS_ACCESS, jobScope, jobCountFacts } from './common.js';

/** groupBy value → Job field it groups on ('origin' is computed, not a field). */
const GROUP_FIELDS = {
  jobType: 'jobType',
  status: 'status',
  experienceLevel: 'experienceLevel',
  company: 'organisation.name',
  city: 'locationMeta.city',
  country: 'locationMeta.country',
  industry: 'organisation.industry',
  origin: null,
};
const GROUP_LABELS = {
  jobType: 'Job type',
  status: 'Status',
  experienceLevel: 'Experience level',
  company: 'Company',
  city: 'City',
  country: 'Country',
  industry: 'Industry',
  origin: 'Origin',
};
const MAX_GROUPS = 25;
const NOT_SET = 'Not set';

/** Merge null/empty buckets into one "Not set", sort by count desc, keep the top 25. */
function shapeGroups(rows) {
  const byValue = new Map();
  for (const { _id, count } of rows) {
    const value = _id === null || _id === undefined || _id === '' ? NOT_SET : String(_id);
    byValue.set(value, (byValue.get(value) || 0) + count);
  }
  const all = [...byValue].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  const total = all.reduce((sum, g) => sum + g.count, 0);
  const groups = all.slice(0, MAX_GROUPS);
  const otherCount = all.slice(MAX_GROUPS).reduce((sum, g) => sum + g.count, 0);
  return { total, groups, ...(otherCount ? { otherCount } : {}) };
}

export default defineTool({
  name: 'count_jobs',
  domain: 'jobs',
  kind: 'read',
  description:
    'Count job postings on the ATS Jobs page (internal openings and mirrored external listings). ' +
    'Use for "how many jobs…" and for breakdowns: "jobs by/per/for each X" → groupBy X.',
  input: Joi.object({
    filters,
    groupBy: Joi.string()
      .valid(...Object.keys(GROUP_FIELDS))
      .description(
        'Break the count down by this field. origin = internal vs external. Jobs have no other ' +
          'groupable fields — if the user asks for one that is not listed, say so instead of guessing.',
      ),
  }),
  access: JOBS_ACCESS,
  async execute({ filters: rawFilters, groupBy } = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);
    const filtersApplied = withDefaultStatus(rawFilters, { groupBy });
    const match = andMongoFilters(buildJobRankingMongoFilter({ filters: filtersApplied }), visibilityFilter);

    if (!groupBy) {
      return { total: await Job.countDocuments(match), filtersApplied };
    }

    if (groupBy === 'origin') {
      const { internal, external, total } = await computeJobOriginCounts(Job, match);
      return {
        total,
        groupBy,
        groups: [
          { value: 'internal', count: internal },
          { value: 'external', count: external },
        ],
        filtersApplied,
      };
    }

    // Model.aggregate skips Mongoose query casting: the visibility clause's string
    // createdBy id would match no ObjectId and silently drop the user's own internal
    // jobs from every breakdown. Query.cast applies the same casting find() gets.
    const $match = Job.find(match).cast(Job);
    const rows = await Job.aggregate([
      { $match },
      { $group: { _id: `$${GROUP_FIELDS[groupBy]}`, count: { $sum: 1 } } },
    ]);
    return { ...shapeGroups(rows), groupBy, filtersApplied };
  },
  render(result) {
    if (!result?.groups) {
      return { blocks: [], facts: jobCountFacts('count_jobs', result?.total ?? 0) };
    }
    const rows = result.groups.map((g) => ({ value: g.value, count: String(g.count) }));
    if (result.otherCount) rows.push({ value: 'Other', count: String(result.otherCount) });
    const block = {
      type: 'table',
      id: 'job-breakdown',
      tableType: 'job-breakdown',
      title: `Jobs by ${GROUP_LABELS[result.groupBy].toLowerCase()} (${result.total})`,
      columns: [
        { key: 'value', label: GROUP_LABELS[result.groupBy], priority: 'primary' },
        { key: 'count', label: 'Jobs', priority: 'primary', format: 'number' },
      ],
      rows,
      layout: 'auto',
    };
    // No count facts for a breakdown: enforceCounts would rewrite each group's
    // "N jobs" in the reply to the overall total.
    return { blocks: [block], facts: { counts: [], primary: null } };
  },
});
