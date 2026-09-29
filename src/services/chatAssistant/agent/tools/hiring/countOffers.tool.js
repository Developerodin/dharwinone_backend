import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { OFFER_STATUSES } from '../../../../../constants/atsPipeline.js';
import { offerFilters } from './filters.js';
import {
  OFFERS_ACCESS, hiringScope, hiringDeps, countOffers, countByBuckets, hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'count_offers',
  domain: 'hiring',
  kind: 'read',
  description:
    'Count job offers (the Offers & Placement page), with a breakdown by offer status (Draft, Sent, Under ' +
    'Negotiation, Accepted, Rejected). Use for "how many offers", "pending/accepted offers", "offers this month".',
  measure:
    'Offer RECORDS (one per offer letter) you are allowed to see on the Offers page (offer/pre-boarding ' +
      'permission = all, otherwise offers on your own jobs or created by you); every status unless ' +
      'filters.status is set. byStatus ignores filters.status.',
  input: Joi.object({ filters: offerFilters }),
  access: OFFERS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
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
