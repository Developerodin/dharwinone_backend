import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { OFFER_STATUSES } from '../../../../../constants/atsPipeline.js';
import {
  OFFERS_ACCESS, hiringScope, countOffers, countByBuckets, hiringCountFacts,
} from './common.js';
import { offerListFilters, detailDeps, offerPlan, countOffersWith } from './placementDetail.js';

export default defineTool({
  name: 'count_offers',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count job offers (the Offers & Placement page), with a breakdown by offer status (Draft, Sent, Under ' +
    'Negotiation, Accepted, Rejected). Use for "how many offers", "pending/accepted offers", "offers this month", ' +
    '"offers pending more than N days" (filters.pendingOverDays — give the number of days the user said), ' +
    '"accepted but pre-boarding not started" (filters.acceptedNoPreboarding).',
  measure:
    'Offer RECORDS (one per offer letter) you are allowed to see on the Offers page (offer/pre-boarding ' +
      'permission = all, otherwise offers on your own jobs or created by you); every status unless ' +
      'filters.status is set. byStatus ignores filters.status, except with pendingOverDays / ' +
      'acceptedNoPreboarding, where it only splits the matching offers.',
  input: Joi.object({ filters: offerListFilters }),
  access: OFFERS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const plan = offerPlan(filters, deps.now());
    if (plan.empty) return { total: 0, byStatus: {}, filtersApplied: filters };
    if (plan.statuses) {
      const [total, byStatus, sentDateMissing] = await Promise.all([
        countOffersWith(plan.query, user, deps),
        countByBuckets((status) => countOffersWith({ ...plan.query, status }, user, deps), plan.statuses),
        plan.sentAtMissingQuery ? countOffersWith(plan.sentAtMissingQuery, user, deps) : 0,
      ]);
      return { total, byStatus, ...(sentDateMissing ? { sentDateMissing } : {}), filtersApplied: filters };
    }
    const [total, byStatus] = await Promise.all([
      countOffers(filters, user, deps),
      countByBuckets((status) => countOffers({ ...filters, status }, user, deps), OFFER_STATUSES),
    ]);
    return { total, byStatus, filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: hiringCountFacts('count_offers', 'offers', result.total) };
  },
});
