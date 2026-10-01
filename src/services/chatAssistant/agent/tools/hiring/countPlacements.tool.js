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

// A zero bucket is not a second total. Sage narrates every count it sees; when the others are 0 their
// sum equals total and the reply restates it. Callers still get every status that is above zero.
const omitZeroCounts = (byStatus) =>
  Object.fromEntries(Object.entries(byStatus).filter(([, count]) => count > 0));

export default defineTool({
  name: 'count_placements',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count placements (accepted offers moving through pre-boarding, onboarding and joining). The spoken ' +
    'answer is total. Mention another status only when its count is above zero, once, and do not restate ' +
    'total. Use for "how many placements", "how many joined this month" (status Joined + joiningBetween), ' +
    '"pending joiners", "deferred placements", "how many in pre-boarding" (stage preBoarding), "how many ' +
    'with BGV pending" (filters.bgvPending), "ready for BGV" (filters.readyForBgv), "joining date passed ' +
    'but not onboarded" (filters.joinDatePassedNotOnboarded), "in onboarding who haven\'t joined" ' +
    '(filters.onboardingNotJoined — joining date today or later, not every Onboarding row).',
  measure:
    'Placement RECORDS (one per accepted offer) you are allowed to see on the Pre-boarding/Onboarding pages; ' +
      'every status EXCEPT Cancelled unless filters.status or filters.stage is set. State total; mention ' +
      'another status only when its count is above zero. Do not restate total as a second queue total. ' +
      'byStatus omits zero counts. bgvPending / readyForBgv / joinDatePassedNotOnboarded default to ' +
      'Pending + Onboarding and only split the matching placements. onboardingNotJoined is status Onboarding ' +
      'with joining date today or later (not Cancelled, Deferred, or Joined). Not employees: a Joined ' +
      'placement is a hiring outcome.',
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
      return { total, byStatus: omitZeroCounts(byStatus), filtersApplied: filters };
    }
    const [total, byStatus] = await Promise.all([
      countPlacements(filters, user, deps),
      countByBuckets(
        (status) => countPlacements({ ...filters, status }, user, deps),
        placementBreakdownStatuses(filters, PLACEMENT_STATUSES),
      ),
    ]);
    return { total, byStatus: omitZeroCounts(byStatus), filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: hiringCountFacts('count_placements', 'placements', result.total) };
  },
});
