import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { PLACEMENT_STATUSES } from '../../../../../constants/atsPipeline.js';
import { placementFilters } from './filters.js';
import {
  PLACEMENTS_ACCESS, hiringScope, hiringDeps, countPlacements, countByBuckets, placementBreakdownStatuses,
  hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'count_placements',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count placements (accepted offers moving through pre-boarding, onboarding and joining), with a breakdown ' +
    'by placement status. Use for "how many placements", "how many joined this month" (status Joined + ' +
    'joiningBetween), "pending joiners", "deferred placements", "how many in pre-boarding" (stage preBoarding).',
  measure:
    'Placement RECORDS (one per accepted offer) you are allowed to see on the Pre-boarding/Onboarding pages; ' +
      'every status EXCEPT Cancelled unless filters.status or filters.stage is set. byStatus ignores ' +
      'filters.status and does include Cancelled. Not employees: a Joined placement is a hiring outcome.',
  input: Joi.object({ filters: placementFilters }),
  access: PLACEMENTS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
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
