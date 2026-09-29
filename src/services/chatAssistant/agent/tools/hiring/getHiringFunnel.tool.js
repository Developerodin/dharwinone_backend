import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { funnelFilters } from './filters.js';
import { REFERRAL_LEADS_ACCESS, hiringScope, hiringDeps, referralWindow } from './common.js';

export default defineTool({
  name: 'get_hiring_funnel',
  domain: 'hiring',
  kind: 'read',
  description:
    'The hiring funnel / tunnel from the Refer Leads page stats: referral leads, then how many are at ' +
    'applied, interview, offer, placement, pre-boarding and onboarded (Employee role), plus conversion rate ' +
    'and paid/unpaid hires. Use for "hiring funnel", "referral pipeline snapshot", "conversion rate", "top ' +
    'referrer". Pre-boarding runs alongside placements, not after them.',
  measure:
    'Referral-lead CANDIDATE profiles (people referred through a job link or onboard invite) you can see on ' +
      'the Refer Leads page — all leads with candidates.manage/interviews.manage, otherwise the ones you ' +
      'referred or are the sales agent for; every pipeline status. Not all candidates, and not employees.',
  input: Joi.object({ filters: funnelFilters }),
  access: REFERRAL_LEADS_ACCESS,
  async execute({ filters = {} } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const query = {
      ...referralWindow(filters.referredBetween),
      ...(filters.linkType ? { referralContext: filters.linkType } : {}),
    };
    const res = await deps.fetchHiringTunnelSnapshot({ user, query });
    if (res?.forbidden) return { error: res.reason || 'You do not have access to referral leads.' };
    const s = res.stats || {};
    const buckets = Object.fromEntries(Object.entries(res.buckets || {}).map(([key, b]) => [
      key, { label: b.label, count: b.count, ...(b.concurrent ? { concurrent: true } : {}) },
    ]));
    return {
      total: s.totalReferrals ?? 0,
      converted: s.converted ?? 0,
      conversionRate: s.conversionRate ?? 0,
      pending: s.pending ?? 0,
      unassignedToSalesAgent: s.unassignedCount ?? 0,
      paidHires: s.paidHires ?? 0,
      unpaidHires: s.unpaidHires ?? 0,
      buckets,
      pipelineCounts: s.pipelineCounts || {},
      topReferrer: s.topReferrer ? { name: s.topReferrer.name, count: s.topReferrer.count } : null,
      topSalesAgent: s.topSalesAgent ? { name: s.topSalesAgent.name, count: s.topSalesAgent.count } : null,
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const rows = Object.values(result.buckets || {}).map((b) => ({
      stage: b.concurrent ? `${b.label} (runs alongside placements)` : b.label,
      count: String(b.count),
    }));
    const blocks = rows.length ? [{
      type: 'table',
      id: 'hiring-funnel',
      tableType: 'hiring-funnel',
      title: `Hiring funnel (${result.total} referral leads)`,
      columns: [
        { key: 'stage', label: 'Stage', priority: 'primary' },
        { key: 'count', label: 'Count', priority: 'primary', format: 'number' },
      ],
      rows,
      layout: 'auto',
    }] : [];
    const fact = { kind: 'get_hiring_funnel', label: 'referral leads', total: result.total };
    return { blocks, facts: { counts: [fact], primary: fact } };
  },
});
