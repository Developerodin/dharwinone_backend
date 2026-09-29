import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { referralLeadFilters } from './filters.js';
import {
  REFERRAL_LEADS_ACCESS, MAX_LIST_LIMIT, hiringScope, hiringDeps, referralWindow, resolveLeadPerson,
  isSelfReference, referralLeadRow,
} from './common.js';

// [filter key, Refer Leads page query key, label]. The service (referralLeadsQueryBuilder applyNewFilters)
// maps salesAgentUserId / unassigned onto currentSalesAgentUserId — the same keys the page sends.
const PERSON_FILTERS = [
  ['referrer', 'referredByUserId', 'referrer'],
  ['salesAgent', 'salesAgentUserId', 'sales agent'],
];

export default defineTool({
  name: 'list_referral_leads',
  domain: 'hiring',
  kind: 'read',
  description:
    'List referral leads (the Refer Leads page): candidate, who referred them, assigned sales agent, job, ' +
    'pipeline status, link type and when the referral was claimed. Use for "who referred <candidate>", ' +
    '"<candidate>\'s sales agent", "what job was <candidate> referred for", "when did <candidate> claim the job", ' +
    '"which candidates did <person> refer", "how many candidates are assigned to <sales agent>". ' +
    'total is the full count even when fewer rows come back.',
  measure:
    'Referral-lead CANDIDATE profiles you can see on the Refer Leads page — all leads with ' +
      'candidates.manage/interviews.manage, otherwise the ones you referred or are the sales agent for; every ' +
      'pipeline status unless filters.status is set.',
  input: Joi.object({
    filters: referralLeadFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: REFERRAL_LEADS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const query = {
      page,
      limit,
      ...(filters.candidate ? { search: filters.candidate } : {}),
      ...(filters.status ? { referralPipelineStatus: filters.status } : {}),
      ...(filters.linkType ? { referralContext: filters.linkType } : {}),
      ...(filters.unassigned ? { unassigned: true } : {}),
      ...referralWindow(filters.claimedBetween),
    };
    const selfId = String(user._id ?? user.id);
    let canSeeAll;
    const seesAll = async () => {
      if (canSeeAll === undefined) canSeeAll = !!(await deps.canSeeAllReferralLeads(user));
      return canSeeAll;
    };
    for (const [key, param, label] of PERSON_FILTERS) {
      if (!filters[key]) continue;
      if (isSelfReference(filters[key], user)) {
        query[param] = selfId;
        continue;
      }
      // A scoped viewer's page only ever shows their own leads, so naming anyone else is refused before
      // any user lookup — the lookup itself would reveal who exists.
      // eslint-disable-next-line no-await-in-loop
      if (!(await seesAll())) {
        return {
          error: 'You can only see referral leads you referred or are the sales agent for, so you cannot ' +
            `filter by another ${label}.`,
        };
      }
      // eslint-disable-next-line no-await-in-loop
      const person = await resolveLeadPerson(key, filters[key], user, deps);
      if (person.notFound) return { notFound: key, total: 0, records: [], filtersApplied: filters };
      if (person.matches) return { ambiguous: key, matches: person.matches, filtersApplied: filters };
      query[param] = person.id;
    }
    const res = await deps.searchReferralLeads(user, query);
    if (res?.forbidden) return { error: res.reason || 'You do not have access to referral leads.' };
    // The page ignores a referrer filter for a scoped viewer (it always shows referred-by-me OR agent-is-me),
    // so "my referrals" there also holds leads where the viewer is only the sales agent.
    const scopeNote = query.referredByUserId === selfId && !(await seesAll())
      ? { note: 'Includes leads you are the sales agent for — the Refer Leads page cannot narrow your view to only the ones you referred.' }
      : {};
    return {
      total: res.total ?? 0,
      page: res.page ?? page,
      totalPages: res.totalPages ?? 0,
      records: (res.results || []).map(referralLeadRow),
      filtersApplied: filters,
      ...scopeNote,
    };
  },
  render(result) {
    // notFound / ambiguous: the person was not resolved, so there is no count to state (not "0 leads").
    if (!result || result.error || result.notFound || !result.records) return null;
    const blocks = result.records.length ? [{
      type: 'table',
      id: 'referral-lead-list',
      tableType: 'referral-lead-list',
      title: `Referral leads (${result.total})`,
      columns: [
        { key: 'candidate', label: 'Candidate', priority: 'primary' },
        { key: 'referredBy', label: 'Referred by', priority: 'primary' },
        { key: 'salesAgent', label: 'Sales agent', priority: 'secondary' },
        { key: 'job', label: 'Job', priority: 'secondary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'claimedAt', label: 'Claimed', priority: 'secondary', format: 'date' },
      ],
      rows: result.records.map((r) => ({
        candidate: r.candidate ?? '—',
        referredBy: r.referredBy ?? '—',
        salesAgent: r.salesAgent ?? '—',
        job: r.job ?? '—',
        status: r.status ?? '—',
        claimedAt: r.claimedAt ?? '—',
      })),
      layout: 'auto',
    }] : [];
    const fact = { kind: 'list_referral_leads', label: 'referral leads', total: result.total };
    return { blocks, facts: { counts: [fact], primary: fact } };
  },
});
