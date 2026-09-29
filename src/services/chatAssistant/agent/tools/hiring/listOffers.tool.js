import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { offerFilters } from './filters.js';
import {
  OFFERS_ACCESS, MAX_LIST_LIMIT, hiringScope, hiringDeps, offerQueryFilter, offerRow, canSeeOfferCompensation,
  hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'list_offers',
  domain: 'hiring',
  kind: 'read',
  description:
    'List job offers, newest first: offer code, candidate, job, status, joining date, and placement status for ' +
    'accepted offers. Use for "show pending offers", "<candidate>\'s offer", "offers for <job>". CTC appears only ' +
    'for viewers allowed to edit offers; when compensationHidden is true, say you cannot show compensation. ' +
    'total is the full count even when fewer rows come back.',
  measure:
    'Offer RECORDS (one per offer letter) you are allowed to see on the Offers page (offer/pre-boarding ' +
      'permission = all, otherwise offers on your own jobs or created by you); every status unless ' +
      'filters.status is set.',
  input: Joi.object({
    filters: offerFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: OFFERS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const [res, showCtc] = await Promise.all([
      deps.queryOffers(offerQueryFilter(filters), { page, limit, sortBy: 'createdAt:desc' }, user),
      canSeeOfferCompensation(user),
    ]);
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: (res?.results || []).map((o) => offerRow(o, { showCtc })),
      ...(showCtc ? {} : { compensationHidden: true }),
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
