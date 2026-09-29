import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { placementFilters } from './filters.js';
import {
  PLACEMENTS_ACCESS, MAX_LIST_LIMIT, hiringScope, hiringDeps, placementQueryFilter, placementRow, hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'list_placements',
  domain: 'hiring',
  kind: 'read',
  description:
    'List placements, latest joining date first: candidate, job, status, pre-boarding status, joining date, ' +
    'BGV status. Use for "who joined this month" (status Joined + joiningBetween), "who is joining next week", ' +
    '"<candidate>\'s placement". total is the full count even when fewer rows come back.',
  measure:
    'Placement RECORDS (one per accepted offer) you are allowed to see on the Pre-boarding/Onboarding pages; ' +
      'every status EXCEPT Cancelled unless filters.status or filters.stage is set.',
  input: Joi.object({
    filters: placementFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: PLACEMENTS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const res = await deps.queryPlacements(
      placementQueryFilter(filters), { page, limit, sortBy: 'joiningDate:desc' }, user,
    );
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: (res?.results || []).map(placementRow),
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'placement-list',
      tableType: 'placement-list',
      title: `Placements (${result.total})`,
      columns: [
        { key: 'candidate', label: 'Candidate', priority: 'primary' },
        { key: 'job', label: 'Job', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'joiningDate', label: 'Joining', priority: 'primary', format: 'date' },
        { key: 'preBoardingStatus', label: 'Pre-boarding', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        candidate: r.candidate ?? '—',
        job: r.job ?? '—',
        status: r.status ?? '—',
        joiningDate: r.joiningDate ?? '—',
        preBoardingStatus: r.preBoardingStatus ?? '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: hiringCountFacts('list_placements', 'placements', result.total) };
  },
});
