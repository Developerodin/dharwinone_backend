import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  PLACEMENTS_ACCESS, MAX_LIST_LIMIT, hiringScope, placementRow, hiringCountFacts,
} from './common.js';
import { placementListFilters, detailDeps, placementPlan, listJoinFacts } from './placementDetail.js';

const SORT = 'joiningDate:desc';

export default defineTool({
  name: 'list_placements',
  domain: 'hiring',
  kind: 'read',
  description:
    'List placements, latest joining date first: candidate, job, status, pre-boarding status, joining date, ' +
    'BGV status. Use for "who joined this month" (status Joined + joiningBetween), "who is joining next week", ' +
    '"<candidate>\'s placement", "BGV pending" (filters.bgvPending), "ready for BGV" (filters.readyForBgv), ' +
    '"joining date passed but not onboarded" (filters.joinDatePassedNotOnboarded), "in onboarding who haven\'t ' +
    'joined" (filters.onboardingNotJoined — joining date today or later). total is the full count ' +
    'even when fewer rows come back. One person\'s steps and what is blocking them → get_placement.',
  measure:
    'Placement RECORDS (one per accepted offer) you are allowed to see on the Pre-boarding/Onboarding pages; ' +
      'every status EXCEPT Cancelled unless filters.status or filters.stage is set (bgvPending / readyForBgv / ' +
      'joinDatePassedNotOnboarded default to Pending + Onboarding; onboardingNotJoined is status Onboarding ' +
      'with joining date today or later).',
  input: Joi.object({
    filters: placementListFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: PLACEMENTS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const plan = placementPlan(filters, deps.now());
    if (plan.empty) return { total: 0, page, totalPages: 0, records: [], filtersApplied: filters };
    const res = await deps.queryPlacements(plan.query, { page, limit, sortBy: SORT }, user);
    const raw = res?.results || [];
    const extras = await listJoinFacts(raw, ctx);
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: raw.map((p, i) => ({ ...placementRow(p), ...extras[i] })),
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
