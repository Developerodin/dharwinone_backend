import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getReferral, { LINK_LOOKUPS_MAX } from '../getReferral.tool.js';
import getReferralStats from '../getReferralStats.tool.js';
import referralsDomain from '../index.js';
import allDomains from '../../index.js';
import { referralMetrics, monthWindows, REFERRALS_ACCESS, OPEN_STAGES } from '../common.js';
import { checkAccessRule } from '../../../../toolAccess.js';
import { assertUniqueToolNames } from '../../../defineTool.js';

const viewer = (...perms) => ({ id: 'v1', _id: 'v1', name: 'Vik', authContext: { permissions: new Set(perms) } });
const NOW = new Date('2026-09-30T20:00:00.000Z'); // 2026-10-01 01:30 IST
const ctxWith = (deps, user = viewer('candidates.read')) => ({ user, requestId: 'r', deps: { now: () => NOW, ...deps } });
const AGENT_ID = '64b000000000000000000009';

const lead = (over = {}) => ({
  id: 'lead-1',
  fullName: 'Priya Shah',
  email: 'priya@example.com',
  referredBy: { id: 'u9', name: 'Sam Agent' },
  salesAgent: { id: 'u9', name: 'Sam Agent' },
  salesAgentAssignedAt: '2026-09-02T10:00:00.000Z',
  salesAgentCurrentAttributionId: 'attr-1',
  referralContext: 'JOB_APPLY',
  referredAt: '2026-09-02T10:00:00.000Z',
  referralPipelineStatus: 'interview',
  job: { id: 'j1', title: 'ML Engineer' },
  referralLastOverride: null,
  ...over,
});

/** Fake User: find(filter).select() → .limit().lean() or .lean(). */
const fakeUsers = (rows) => ({
  find: () => ({ select: () => ({ limit: () => ({ lean: async () => rows }), lean: async () => rows }) }),
});
const fakeLeads = (ids) => ({ distinct: async () => ids });
const noLookup = {
  User: { find: () => assert.fail('must not look up users') },
  Employee: { distinct: () => assert.fail('must not look up leads'), find: () => assert.fail('must not read leads') },
};

const stats = (totalReferrals, pipelineCounts, conversionRate = 50) => ({
  stats: { totalReferrals, pipelineCounts, conversionRate },
});
/** Default grouped-service stubs for agentDetail. */
const detailStubs = (over = {}) => ({
  statsByAgent: async () => [{ salesAgentUserId: null, totalReferrals: 0, pipelineCounts: {}, conversionRate: 0, avgReferralToJoiningDays: null, joinedWithDates: 0 }],
  stageAges: async () => ({}),
  ...over,
});

describe('referral tools — access and fail closed', () => {
  const failDeps = {
    searchReferralLeads: () => assert.fail('called'),
    fetchHiringTunnelSnapshot: () => assert.fail('called'),
    canSeeAllReferralLeads: () => assert.fail('called'),
  };
  for (const tool of [getReferral, getReferralStats]) {
    it(`${tool.name} refuses to run without a user id`, async () => {
      await assert.rejects(() => tool.execute({ person: 'x' }, { user: {}, deps: failDeps }), /authenticated user/);
    });
    it(`${tool.name} needs candidates.read (the Refer Leads route permission)`, async () => {
      assert.equal(tool.access, REFERRALS_ACCESS);
      assert.equal((await checkAccessRule(tool.access, viewer('jobs.read'))).ok, false);
      assert.equal((await checkAccessRule(tool.access, viewer('candidates.read'))).ok, true);
    });
  }

  it('a service-level refusal comes back as an error, not data', async () => {
    const out = await getReferral.execute({ person: 'Priya' }, ctxWith({
      searchReferralLeads: async () => ({ forbidden: true, reason: 'Missing candidates.read' }),
    }));
    assert.deepEqual(out, { error: 'Missing candidates.read' });
  });

  it('a refusal from a grouped stats call is an error, not zeros', async () => {
    const out = await getReferralStats.execute({}, ctxWith({
      ...noLookup,
      canSeeAllReferralLeads: async () => false,
      fetchHiringTunnelSnapshot: async () => stats(1, { applied: 1 }),
      ...detailStubs({ stageAges: async () => ({ forbidden: true, reason: 'Missing candidates.read' }) }),
    }));
    assert.deepEqual(out, { error: 'Missing candidates.read' });
  });
});

describe('get_referral', () => {
  it('returns referrer, agent, ids, channel, date and who issued the link', async () => {
    const seen = { search: [], logs: [] };
    const user = viewer('candidates.read');
    const out = await getReferral.execute({ person: 'Priya' }, ctxWith({
      searchReferralLeads: async (u, q) => { seen.search.push({ u, q }); return { total: 1, results: [lead()] }; },
      fetchReferralJtis: async (ids) => new Map(ids.map((id) => [id, 'jti-abc'])),
      queryActivityLogs: async (filter, options, v) => {
        seen.logs.push({ filter, options, v });
        return { results: [{ actor: { name: 'Sam Agent' }, createdAt: '2026-09-01T09:00:00.000Z' }] };
      },
    }, user));
    assert.equal(seen.search[0].u, user, 'the viewer goes to the service so its row scope applies');
    assert.equal(seen.search[0].q.search, 'Priya');
    assert.deepEqual(seen.logs[0].filter, { action: 'referral.link.issued', entityType: 'Referral', entityId: 'jti-abc' });
    assert.equal(seen.logs[0].v, user);
    assert.equal(out.total, 1);
    const r = out.records[0];
    assert.equal(r.referredBy, 'Sam Agent');
    assert.equal(r.salesAgent, 'Sam Agent');
    assert.equal(r.attributionId, 'attr-1');
    assert.equal(r.channel, 'Job link');
    assert.equal(r.referred, true);
    assert.deepEqual(r.linkIssued, { issuedBy: 'Sam Agent', issuedAt: '2026-09-01T09:00:00.000Z' });
    assert.match(out.notCaptured, /WhatsApp shares and referral-link opens are not captured/);
  });

  it('missing data is null: no referralJti means no link record and no ActivityLog read', async () => {
    const out = await getReferral.execute({ person: 'Priya' }, ctxWith({
      searchReferralLeads: async () => ({ total: 1, results: [lead({ referredBy: null, salesAgent: null, referralContext: null })] }),
      fetchReferralJtis: async () => new Map(),
      queryActivityLogs: () => assert.fail('no jti, no lookup'),
    }));
    const r = out.records[0];
    assert.equal(r.referredBy, null);
    assert.equal(r.salesAgent, null);
    assert.equal(r.channel, null);
    assert.equal(r.linkIssued, null);
    assert.match(r.linkIssuedNote, /No link-issued record/);
  });

  it(`looks up link issuance for at most ${LINK_LOOKUPS_MAX} matches`, async () => {
    let lookups = 0;
    const results = Array.from({ length: 7 }, (_, i) => lead({ id: `lead-${i}` }));
    const out = await getReferral.execute({ person: 'P' }, ctxWith({
      searchReferralLeads: async () => ({ total: 7, results }),
      fetchReferralJtis: async (ids) => { assert.equal(ids.length, LINK_LOOKUPS_MAX); return new Map(ids.map((id) => [id, `j-${id}`])); },
      queryActivityLogs: async () => { lookups += 1; return { results: [] }; },
    }));
    assert.equal(lookups, LINK_LOOKUPS_MAX);
    assert.match(out.records[6].linkIssuedNote, /first 5/);
  });

  it('row scope: a scoped viewer with no match gets referred null and no wider lookup', async () => {
    const out = await getReferral.execute({ person: 'Priya' }, ctxWith({
      searchReferralLeads: async () => ({ total: 0, results: [] }),
      canSeeAllReferralLeads: async () => false,
      runPersonList: () => assert.fail('a scoped viewer must not search beyond their own leads'),
      referrerIdsFor: () => assert.fail('a scoped viewer must not probe referrers'),
    }, viewer('candidates.read')));
    assert.equal(out.referred, null);
    assert.equal(out.total, 0);
    assert.match(out.note, /outside your view/);
  });

  it('an org-wide viewer learns the person came in directly when no referrer is recorded', async () => {
    const seen = [];
    const out = await getReferral.execute({ person: 'Dev' }, ctxWith({
      searchReferralLeads: async () => ({ total: 0, results: [] }),
      canSeeAllReferralLeads: async () => true,
      runPersonList: async (args) => { seen.push(args); return { total: 1, records: [{ id: 'e1', name: 'Dev Rao', email: 'dev@x.com' }] }; },
      referrerIdsFor: async () => new Set(),
    }));
    assert.equal(seen[0].ownerUserRole, 'candidate');
    assert.deepEqual(seen[0].filters, { search: 'Dev' });
    assert.deepEqual(out.direct, [{ candidate: 'Dev Rao', email: 'dev@x.com', referred: false, referredBy: null }]);
    assert.match(out.note, /directly/);
  });

  it('bug: a person matched on another field (employee id) who HAS a referrer is not called direct', async () => {
    const searches = [];
    const out = await getReferral.execute({ person: 'DBS260' }, ctxWith({
      searchReferralLeads: async (u, q) => {
        searches.push(q.search);
        return q.search === 'rafi@x.com' ? { total: 1, results: [lead({ id: 'e7', fullName: 'Rafiqul' })] } : { total: 0, results: [] };
      },
      canSeeAllReferralLeads: async () => true,
      runPersonList: async () => ({ total: 1, records: [{ id: 'e7', name: 'Rafiqul', email: 'rafi@x.com' }] }),
      referrerIdsFor: async (ids) => { assert.deepEqual(ids, ['e7']); return new Set(['e7']); },
      fetchReferralJtis: async () => new Map(),
    }));
    assert.deepEqual(searches, ['DBS260', 'rafi@x.com']);
    assert.equal(out.direct, undefined);
    assert.equal(out.total, 1);
    assert.equal(out.records[0].candidate, 'Rafiqul');
    assert.equal(out.records[0].referredBy, 'Sam Agent');
  });

  it('a referred person missing from the Refer Leads page is reported as referred, never as direct', async () => {
    const out = await getReferral.execute({ person: 'Ghost' }, ctxWith({
      searchReferralLeads: async () => ({ total: 0, results: [] }),
      canSeeAllReferralLeads: async () => true,
      runPersonList: async () => ({ total: 1, records: [{ id: 'e8', name: 'Ghost', email: 'g@x.com' }] }),
      referrerIdsFor: async () => new Set(['e8']),
      fetchReferralJtis: async () => new Map(),
    }));
    assert.equal(out.direct, undefined);
    assert.deepEqual(out.unlisted, [{ candidate: 'Ghost', referred: true }]);
    assert.match(out.unlistedNote, /not on the Refer Leads page/);
  });

  it('nobody found anywhere → notFound', async () => {
    const out = await getReferral.execute({ person: 'Nobody' }, ctxWith({
      searchReferralLeads: async () => ({ total: 0, results: [] }),
      canSeeAllReferralLeads: async () => true,
      runPersonList: async () => ({ total: 0, records: [] }),
      referrerIdsFor: () => assert.fail('no people, no lookup'),
    }));
    assert.equal(out.notFound, true);
    assert.equal(getReferral.render(out), null);
  });
});

describe('get_referral_stats', () => {
  it('row scope: a scoped viewer cannot name another sales agent by name, id, email or case (refused before any lookup)', async () => {
    for (const salesAgent of ['Sam Agent', AGENT_ID, 'sam@x.com', 'SAM']) {
      const out = await getReferralStats.execute({ salesAgent }, ctxWith({
        ...noLookup,
        canSeeAllReferralLeads: async () => false,
        fetchHiringTunnelSnapshot: () => assert.fail('no stats for someone else'),
        statsByAgent: () => assert.fail('no stats for someone else'),
      }));
      assert.match(out.error, /cannot ask about another sales agent/, salesAgent);
    }
  });

  it('a scoped viewer with no salesAgent gets their own numbers (no agent filter, the service scopes)', async () => {
    const queries = [];
    const user = viewer('candidates.read');
    const out = await getReferralStats.execute({ rankBy: 'joined' }, ctxWith({
      ...noLookup,
      canSeeAllReferralLeads: async () => false,
      fetchHiringTunnelSnapshot: async ({ user: u, query }) => { queries.push({ u, query }); return stats(4, { applied: 2, pending: 2 }); },
      ...detailStubs({
        statsByAgent: async (u, q, opts) => { queries.push({ u, query: q }); assert.equal(opts.groupBySalesAgent, false); return []; },
        stageAges: async (u, q) => { queries.push({ u, query: q }); return {}; },
      }),
    }, user));
    assert.equal(queries.length, 5);
    assert.ok(queries.every((q) => q.u === user && !('salesAgentUserId' in q.query)));
    assert.equal(out.salesAgent, null);
    assert.equal(out.referred, 4);
    assert.equal(out.agents, undefined, 'a scoped viewer never gets a ranking');
    assert.match(out.scope, /Your referral leads/);
  });

  it('bug: a scoped Sales Agent asking "me" gets their page scope (referred OR agent), not agent-only', async () => {
    const queries = [];
    const out = await getReferralStats.execute({ salesAgent: 'me' }, ctxWith({
      ...noLookup,
      canSeeAllReferralLeads: async () => false,
      fetchHiringTunnelSnapshot: async ({ query }) => { queries.push(query); return stats(3, { applied: 3 }); },
      ...detailStubs(),
    }));
    assert.ok(queries.every((q) => !('salesAgentUserId' in q)));
    assert.match(out.scope, /ones you referred or are the sales agent for/);
  });

  it('per sales agent: metrics, exact average days to joining, days in stage and month over month', async () => {
    const queries = [];
    const out = await getReferralStats.execute({ salesAgent: 'Sam' }, ctxWith({
      canSeeAllReferralLeads: async () => true,
      Employee: fakeLeads([AGENT_ID]),
      User: fakeUsers([{ _id: AGENT_ID, name: 'Sam Agent', status: 'active' }]),
      fetchHiringTunnelSnapshot: async ({ query }) => {
        queries.push(query);
        if (query.from?.startsWith('2026-09-30T18:30')) return stats(2, { pending: 1, joined: 1 }); // this IST month
        if (query.from?.startsWith('2026-08-31T18:30')) return stats(4, { applied: 4 }); // last IST month
        return stats(10, { pending: 2, profile_complete: 1, applied: 2, interview: 1, in_review: 1, offer: 1, employee: 2 }, 70);
      },
      statsByAgent: async (u, q, opts) => {
        queries.push(q);
        assert.equal(opts.groupBySalesAgent, false);
        return [{ salesAgentUserId: null, totalReferrals: 10, pipelineCounts: {}, conversionRate: 70, avgReferralToJoiningDays: 15, joinedWithDates: 2 }];
      },
      stageAges: async (u, q) => {
        queries.push(q);
        return { interview: { count: 2, withDate: 1, avgDays: 9.5, oldestDays: 9 } };
      },
    }, viewer('candidates.read', 'candidates.manage')));
    assert.ok(queries.every((q) => q.salesAgentUserId === AGENT_ID));
    assert.equal(out.salesAgent, 'Sam Agent');
    assert.equal(out.referred, 10);
    assert.equal(out.neverApplied, 3);
    assert.equal(out.applied, 7);
    assert.equal(out.offers, 3);
    assert.equal(out.joined, 2);
    assert.equal(out.joinRatePercent, 20);
    assert.equal(out.pageConversionPercent, 70);
    assert.equal(out.avgReferralToJoiningDays, 15);
    assert.match(out.avgReferralToJoiningBasis, /all 2 joined lead/);
    const interview = out.stuck.byStage.find((s) => s.stage === 'interview');
    assert.deepEqual(interview, { stage: 'interview', count: 2, avgDaysInStage: 9.5, oldestDaysInStage: 9, leadsWithStageDate: 1 });
    const offer = out.stuck.byStage.find((s) => s.stage === 'offer');
    assert.deepEqual(offer, { stage: 'offer', count: 1, avgDaysInStage: null, oldestDaysInStage: null, leadsWithStageDate: 0 });
    assert.deepEqual(out.stuck.byStage.map((s) => s.stage), OPEN_STAGES);
    assert.match(out.stuck.basis, /first interview scheduled/);
    assert.deepEqual(out.monthOverMonth.thisMonth, { from: '2026-10-01', to: '2026-10-01', referred: 2, joined: 1 });
    assert.deepEqual(out.monthOverMonth.lastMonth, { from: '2026-09-01', to: '2026-09-30', referred: 4, joined: 0 });
    assert.equal(out.monthOverMonth.referredChangePercent, -50);
  });

  it('the average says how many joined leads it leaves out (no referral date, or backfilled before it)', async () => {
    const out = await getReferralStats.execute({}, ctxWith({
      ...noLookup,
      canSeeAllReferralLeads: async () => false,
      fetchHiringTunnelSnapshot: async () => stats(5, { employee: 3, applied: 2 }),
      ...detailStubs({
        statsByAgent: async () => [{ salesAgentUserId: null, totalReferrals: 5, pipelineCounts: {}, conversionRate: 100, avgReferralToJoiningDays: 4, joinedWithDates: 1 }],
      }),
    }));
    assert.equal(out.avgReferralToJoiningDays, 4);
    assert.match(out.avgReferralToJoiningBasis, /over all 1 joined lead\(s\) with both dates; 2 other joined lead\(s\) are left out/);
  });

  it('missing data: no joined lead with both dates → average null', async () => {
    const out = await getReferralStats.execute({ salesAgent: 'me' }, ctxWith({
      ...noLookup,
      canSeeAllReferralLeads: async () => false,
      fetchHiringTunnelSnapshot: async () => stats(0, {}),
      ...detailStubs({ statsByAgent: async () => [] }),
    }));
    assert.equal(out.avgReferralToJoiningDays, null);
    assert.match(out.avgReferralToJoiningBasis, /No joined lead/);
    assert.equal(out.joinRatePercent, null);
    assert.equal(out.monthOverMonth.referredChangePercent, null);
  });

  it('ranked: ONE grouped call for every sales agent, sorted by rankBy, with total and no cap', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `a${i}`);
    let grouped = 0;
    const out = await getReferralStats.execute({ rankBy: 'joined', limit: 3 }, ctxWith({
      canSeeAllReferralLeads: async () => true,
      Employee: fakeLeads(ids),
      User: fakeUsers(ids.map((id) => ({ _id: id, name: `Agent ${id}`, status: 'active' }))),
      fetchHiringTunnelSnapshot: () => assert.fail('ranking must not call the per-agent stats'),
      statsByAgent: async (u, q, opts) => {
        grouped += 1;
        assert.equal(opts.groupBySalesAgent, true);
        return [
          { salesAgentUserId: 'a1', totalReferrals: 5, pipelineCounts: { employee: 1, applied: 4 }, conversionRate: 100, avgReferralToJoiningDays: 12, joinedWithDates: 1 },
          { salesAgentUserId: 'a19', totalReferrals: 9, pipelineCounts: { employee: 3, pending: 6 }, conversionRate: 33.3, avgReferralToJoiningDays: 20, joinedWithDates: 3 },
          { salesAgentUserId: null, totalReferrals: 4, pipelineCounts: { pending: 4 }, conversionRate: 0, avgReferralToJoiningDays: null, joinedWithDates: 0 },
        ];
      },
    }));
    assert.equal(grouped, 1);
    assert.equal(out.total, 20);
    assert.deepEqual(out.agents.map((a) => [a.salesAgent, a.joined]), [['Agent a19', 3], ['Agent a1', 1], ['Agent a0', 0]]);
    assert.equal(out.agents[0].avgReferralToJoiningDays, 20);
    assert.equal(out.agents[0].pageConversionPercent, 33.3);
    assert.equal(out.unassignedLeads, 4);
    assert.equal(out.poolNote, undefined);
    assert.equal(getReferralStats.render(out).blocks[0].type, 'table');
  });

  it('rejects a malformed referredBetween day instead of querying', async () => {
    await assert.rejects(() => getReferralStats.execute({ referredBetween: { from: '2026-02-30' } }, ctxWith({
      canSeeAllReferralLeads: () => assert.fail('must validate first'),
    })), /Invalid date/);
  });
});

describe('referral helpers', () => {
  it('referralMetrics buckets the Refer Leads statuses', () => {
    const m = referralMetrics({ totalReferrals: 6, pipelineCounts: { pending: 1, rejected: 1, withdrawn: 1, hired: 1, resigned: 1, preboarding: 1 }, conversionRate: 80 });
    assert.deepEqual(
      { applied: m.applied, active: m.active, offers: m.offers, joined: m.joined, rejected: m.rejected, withdrawn: m.withdrawn },
      { applied: 5, active: 2, offers: 3, joined: 1, rejected: 1, withdrawn: 1 },
    );
  });

  it('referralMetrics of nothing is zeros with null rates, never NaN', () => {
    const m = referralMetrics({});
    assert.equal(m.referred, 0);
    assert.equal(m.joinRatePercent, null);
    assert.equal(m.pageConversionPercent, null);
  });

  it('monthWindows uses the IST calendar, not UTC', () => {
    assert.deepEqual(monthWindows(new Date('2026-09-30T20:00:00.000Z')), {
      thisMonth: { from: '2026-10-01', to: '2026-10-01' },
      lastMonth: { from: '2026-09-01', to: '2026-09-30' },
    });
    // January → last month is December of the previous year
    assert.deepEqual(monthWindows(new Date('2027-01-15T06:00:00.000Z')).lastMonth, { from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('referrals domain module', () => {
  it('exports { domain, summary, instructions, tools } with a short summary', () => {
    assert.equal(referralsDomain.domain, 'referrals');
    assert.ok(referralsDomain.summary.length <= 120);
    assert.ok(referralsDomain.instructions.length > 0);
    assert.deepEqual(referralsDomain.tools.map((t) => t.name), ['get_referral', 'get_referral_stats']);
    for (const t of referralsDomain.tools) {
      assert.equal(t.kind, 'read');
      assert.equal(t.domain, 'referrals');
      assert.equal(t.jsonSchema.type, 'object');
    }
  });

  it('tool names stay unique once referrals is registered next to every other domain', () => {
    const others = allDomains.filter((d) => d.domain !== 'referrals').flatMap((d) => d.tools);
    assert.doesNotThrow(() => assertUniqueToolNames([...others, ...referralsDomain.tools]));
  });
});
