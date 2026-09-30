import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { PLACEMENT_STATUSES } from '../../../../../constants/atsPipeline.js';
import {
  PLACEMENTS_ACCESS, hiringScope, countPlacements, countByBuckets, placementBreakdownStatuses,
  hiringCountFacts,
} from './common.js';
import { placementListFilters, detailDeps, placementPlan } from './placementDetail.js';

const countWith = async (query, user, deps) =>
  (await deps.queryPlacements(query, { limit: 1 }, user))?.totalResults ?? 0;

export default defineTool({
  name: 'count_placements',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count placements (accepted offers moving through pre-boarding, onboarding and joining), with a breakdown ' +
    'by placement status. Use for "how many placements", "how many joined this month" (status Joined + ' +
    'joiningBetween), "pending joiners", "deferred placements", "how many in pre-boarding" (stage preBoarding), ' +
    '"how many with BGV pending" (filters.bgvPending), "ready for BGV" (filters.readyForBgv), "joining date ' +
    'passed but not onboarded" (filters.joinDatePassedNotOnboarded).',
  measure:
    'Placement RECORDS (one per accepted offer) you are allowed to see on the Pre-boarding/Onboarding pages; ' +
      'every status EXCEPT Cancelled unless filters.status or filters.stage is set. byStatus ignores ' +
      'filters.status and does include Cancelled — except with bgvPending / readyForBgv / ' +
      'joinDatePassedNotOnboarded, which default to Pending + Onboarding and only split the matching ' +
      'placements. Not employees: a Joined placement is a hiring outcome.',
  input: Joi.object({ filters: placementListFilters }),
  access: PLACEMENTS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const plan = placementPlan(filters, deps.now());
    if (plan.empty) return { total: 0, byStatus: {}, filtersApplied: filters };
    if (plan.statuses) {
      const [total, byStatus] = await Promise.all([
        countWith(plan.query, user, deps),
        countByBuckets((status) => countWith({ ...plan.query, status }, user, deps), plan.statuses),
      ]);
      return { total, byStatus, filtersApplied: filters };
    }
    const [total, byStatus] = await Promise.all([
      countPlacements(filters, user, deps),
      countByBuckets(
        (status) => countPlacements({ ...filters, status }, user, deps),
        placementBreakdownStatuses(filters, PLACEMENT_STATUSES),
      ),
    ]);
    return { total, byStatus, filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: hiringCountFacts('count_placements', 'placements', result.total) };
  },
});
