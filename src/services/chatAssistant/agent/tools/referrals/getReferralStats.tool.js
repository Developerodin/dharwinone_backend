import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  REFERRALS_ACCESS, MAX_LIST_LIMIT, SHARES_NOT_CAPTURED, METRIC_DEFINITIONS, OPEN_STAGES, STAGE_ENTRY_BASIS,
  referralsScope, referralsDeps, referralWindow, resolveLeadPerson, isSelfReference, referralMetrics,
  monthWindows, listLeadSalesAgents,
} from './common.js';

const RANK_KEYS = Object.freeze({
  referred: 'referred',
  applied: 'applied',
  never_applied: 'neverApplied',
  active: 'active',
  offers: 'offers',
  joined: 'joined',
  join_rate: 'joinRatePercent',
});

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.');

const percentChange = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);
const DENIED = 'You do not have access to referral leads.';
const deniedOf = (...results) => results.find((r) => r?.forbidden);

/** getReferralLeadsStatsByAgent group → the stats shape referralMetrics reads. */
const groupStats = (g) => (g ? { totalReferrals: g.totalReferrals, pipelineCounts: g.pipelineCounts, conversionRate: g.conversionRate } : {});

async function agentDetail({ agent, window, referredBetween, user, deps, now }) {
  const base = agent ? { salesAgentUserId: agent.id } : {};
  const { thisMonth, lastMonth } = monthWindows(now);
  const snap = (query) => deps.fetchHiringTunnelSnapshot({ user, query });
  const [main, cur, prev, grouped, ages] = await Promise.all([
    snap({ ...base, ...window }),
    snap({ ...base, ...referralWindow(thisMonth) }),
    snap({ ...base, ...referralWindow(lastMonth) }),
    deps.statsByAgent(user, { ...base, ...window }, { groupBySalesAgent: false }),
    deps.stageAges(user, { ...base, ...window }),
  ]);
  const denied = deniedOf(main, cur, prev, grouped, ages);
  if (denied) return { error: denied.reason || DENIED };

  const counts = main?.stats?.pipelineCounts || {};
  const whole = Array.isArray(grouped) ? grouped[0] : null;
  const metrics = referralMetrics(main?.stats);
  const curM = referralMetrics(cur?.stats);
  const prevM = referralMetrics(prev?.stats);
  const leftOut = Math.max(metrics.joined - (whole?.joinedWithDates ?? 0), 0);
  return {
    salesAgent: agent ? agent.name : null,
    scope: agent
      ? 'Referral leads with this sales agent assigned, among the leads you can see.'
      : 'Your referral leads: ones you referred or are the sales agent for.',
    referredBetween: referredBetween ?? null,
    ...metrics,
    definitions: METRIC_DEFINITIONS,
    avgReferralToJoiningDays: whole?.avgReferralToJoiningDays ?? null,
    avgReferralToJoiningBasis: whole?.joinedWithDates
      ? `Mean days from the referral date to the joining date over all ${whole.joinedWithDates} joined lead(s) ` +
        'with both dates' +
        (leftOut
          ? `; ${leftOut} other joined lead(s) are left out — no referral date, or a joining date before the ` +
            'referral (backfilled employees).'
          : '.')
      : 'No joined lead has both a referral date and a joining date on or after it.',
    stuck: {
      byStage: OPEN_STAGES.map((stage) => {
        const age = ages?.[stage];
        return {
          stage,
          count: Number(counts[stage] || 0) + (stage === 'interview' ? Number(counts.in_review || 0) : 0),
          avgDaysInStage: age?.avgDays ?? null,
          oldestDaysInStage: age?.oldestDays ?? null,
          leadsWithStageDate: age?.withDate ?? 0,
        };
      }),
      basis: STAGE_ENTRY_BASIS,
    },
    monthOverMonth: {
      thisMonth: { ...thisMonth, referred: curM.referred, joined: curM.joined },
      lastMonth: { ...lastMonth, referred: prevM.referred, joined: prevM.joined },
      referredChangePercent: percentChange(curM.referred, prevM.referred),
      basis: 'Referrals claimed in each IST month, and how many of those have joined so far.',
    },
    notCaptured: SHARES_NOT_CAPTURED,
  };
}

/** Every sales agent holding a lead, ranked from one grouped aggregation (no per-agent calls, no cap). */
async function rankAgents({ rankBy, limit, window, referredBetween, user, deps }) {
  const [agents, grouped] = await Promise.all([
    listLeadSalesAgents(user, deps),
    deps.statsByAgent(user, { ...window }, { groupBySalesAgent: true }),
  ]);
  if (grouped?.forbidden) return { error: grouped.reason || DENIED };
  const byAgent = new Map((grouped || []).map((g) => [g.salesAgentUserId, g]));
  const key = RANK_KEYS[rankBy];
  const rows = agents
    .map((a) => {
      const g = byAgent.get(a.id);
      return { salesAgent: a.name, ...referralMetrics(groupStats(g)), avgReferralToJoiningDays: g?.avgReferralToJoiningDays ?? null };
    })
    .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  return {
    rankBy,
    total: rows.length,
    agents: rows.slice(0, limit),
    unassignedLeads: byAgent.get(null)?.totalReferrals ?? 0,
    referredBetween: referredBetween ?? null,
    definitions: METRIC_DEFINITIONS,
    detailNote: 'Stuck leads and month-over-month are per sales agent — ask about one agent.',
    notCaptured: SHARES_NOT_CAPTURED,
  };
}

export default defineTool({
  name: 'get_referral_stats',
  domain: 'referrals',
  kind: 'read',
  description:
    'Referral performance from the Refer Leads page. With salesAgent (a name, email or "me"): referred, applied, ' +
    'never applied, active, offers, joined, join rate and the page conversion %, average days from referral to ' +
    'joining, leads per open stage with how many days they have sat there, and this month vs last month. ' +
    'Without it: ranks every sales agent by rankBy. Sales Agents only ever get their own numbers.',
  measure:
    'Referral-lead CANDIDATE profiles you can see on the Refer Leads page (all leads with candidates.manage / ' +
      'interviews.manage and no Sales Agent role, otherwise ones you referred or are the sales agent for), by ' +
      'the status the page shows.',
  input: Joi.object({
    salesAgent: Joi.string().min(1).max(200)
      .description('One sales agent — name, email, or "me". Omit to rank sales agents.'),
    rankBy: Joi.string().valid(...Object.keys(RANK_KEYS)).default('referred')
      .description('Ranking when no salesAgent is given.'),
    referredBetween: Joi.object({ from: isoDay, to: isoDay }).or('from', 'to')
      .description('Only referrals claimed on or between these days (inclusive, IST), resolved from today\'s date.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20)
      .description('Max ranked rows (default 20). total is always the full count.'),
  }),
  access: REFERRALS_ACCESS,
  async execute({ salesAgent, rankBy = 'referred', referredBetween, limit = 20 } = {}, ctx) {
    const user = referralsScope(ctx);
    const deps = referralsDeps(ctx);
    const now = deps.now();
    const window = referralWindow(referredBetween);
    const seesAll = !!(await deps.canSeeAllReferralLeads(user));
    const common = { window, referredBetween, user, deps, now };

    if (salesAgent) {
      if (isSelfReference(salesAgent, user)) {
        // A scoped viewer's own numbers are their Refer Leads page: leads they referred OR are the sales agent
        // for. Filtering by sales agent would drop leads they referred that were reassigned to someone else.
        if (!seesAll) return agentDetail({ ...common, agent: null });
        return agentDetail({ ...common, agent: { id: String(user._id ?? user.id), name: user.name ?? null } });
      }
      // Refused before any lookup: a scoped viewer's numbers only ever cover their own leads, and the lookup
      // itself would reveal who exists.
      if (!seesAll) {
        return {
          error: 'You can only see referral numbers for leads you referred or are the sales agent for, so you ' +
            'cannot ask about another sales agent.',
        };
      }
      const person = await resolveLeadPerson('salesAgent', salesAgent, user, deps);
      if (person.notFound) return { notFound: 'salesAgent' };
      if (person.matches) return { ambiguous: 'salesAgent', matches: person.matches };
      return agentDetail({ ...common, agent: person });
    }

    if (!seesAll) return agentDetail({ ...common, agent: null });
    return rankAgents({ ...common, rankBy, limit: Math.min(limit, MAX_LIST_LIMIT) });
  },
  render(result) {
    if (!result?.agents?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'referral-stats',
        tableType: 'referral-stats',
        title: `Sales agents by ${result.rankBy.replace(/_/g, ' ')} (${result.total})`,
        columns: [
          { key: 'salesAgent', label: 'Sales agent', priority: 'primary' },
          { key: 'referred', label: 'Referred', priority: 'primary', format: 'number' },
          { key: 'applied', label: 'Applied', priority: 'secondary', format: 'number' },
          { key: 'offers', label: 'Offers', priority: 'secondary', format: 'number' },
          { key: 'joined', label: 'Joined', priority: 'primary', format: 'number' },
        ],
        rows: result.agents.map((r) => ({
          salesAgent: r.salesAgent ?? '—',
          referred: String(r.referred),
          applied: String(r.applied),
          offers: String(r.offers),
          joined: String(r.joined),
        })),
        layout: 'auto',
      }],
    };
  },
});
