import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  OFFERS_ACCESS, MAX_LIST_LIMIT, hiringScope, offerRow, canSeeOfferCompensation, hiringCountFacts,
} from './common.js';
import { offerListFilters, detailDeps, offerPlan, countOffersWith, offerDaysPending } from './placementDetail.js';

export default defineTool({
  name: 'list_offers',
  domain: 'hiring',
  kind: 'read',
  description:
    'List job offers, newest first: offer code, candidate, job, status, joining date, and placement status for ' +
    'accepted offers. Use for "show pending offers", "<candidate>\'s offer", "offers for <job>", "offers ' +
    'pending more than N days" (filters.pendingOverDays; sentDateMissing = still-pending offers with no sent date on record, never counted), "accepted but pre-boarding not started" ' +
    '(filters.acceptedNoPreboarding). CTC appears only for viewers allowed to edit offers; when ' +
    'compensationHidden is true, say you cannot show compensation. total is the full count even when fewer ' +
    'rows come back. One offer in full → get_offer.',
  measure:
    'Offer RECORDS (one per offer letter) you are allowed to see on the Offers page (offer/pre-boarding ' +
      'permission = all, otherwise offers on your own jobs or created by you); every status unless ' +
      'filters.status is set.',
  input: Joi.object({
    filters: offerListFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: OFFERS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const now = deps.now();
    const plan = offerPlan(filters, now);
    const showCtc = await canSeeOfferCompensation(user);
    const hide = showCtc ? {} : { compensationHidden: true };
    if (plan.empty) return { total: 0, page, totalPages: 0, records: [], ...hide, filtersApplied: filters };

    const toRow = (o) => {
      const row = offerRow(o, { showCtc });
      return filters.pendingOverDays ? { ...row, daysPending: offerDaysPending(o, now) } : row;
    };
    const [res, sentDateMissing] = await Promise.all([
      deps.queryOffers(plan.query, { page, limit, sortBy: 'createdAt:desc' }, user),
      plan.sentAtMissingQuery ? countOffersWith(plan.sentAtMissingQuery, user, deps) : 0,
    ]);
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: (res?.results || []).map(toRow),
      ...hide,
      ...(sentDateMissing ? { sentDateMissing } : {}),
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'offer-list',
      tableType: 'offer-list',
      title: `Offers (${result.total})`,
      columns: [
        { key: 'candidate', label: 'Candidate', priority: 'primary' },
        { key: 'job', label: 'Job', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'joiningDate', label: 'Joining', priority: 'secondary', format: 'date' },
        { key: 'offerCode', label: 'Offer', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        candidate: r.candidate ?? '—',
        job: r.job ?? r.position ?? '—',
        status: r.placementStatus ? `${r.status} (${r.placementStatus})` : (r.status ?? '—'),
        joiningDate: r.joiningDate ?? '—',
        offerCode: r.offerCode ?? '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: hiringCountFacts('list_offers', 'offers', result.total) };
  },
});
