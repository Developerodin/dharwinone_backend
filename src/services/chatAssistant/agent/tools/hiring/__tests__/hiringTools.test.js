import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countInterviews from '../countInterviews.tool.js';
import listInterviews from '../listInterviews.tool.js';
import countOffers from '../countOffers.tool.js';
import listOffers from '../listOffers.tool.js';
import countPlacements from '../countPlacements.tool.js';
import listPlacements from '../listPlacements.tool.js';
import getHiringFunnel from '../getHiringFunnel.tool.js';
import listReferralLeads from '../listReferralLeads.tool.js';
import { matchesTurn } from '../index.js';
import { interviewMongoFilter, referralWindow } from '../common.js';
import { applyNewFilters } from '../../../../../referralLeadsQueryBuilder.js';
import { referredAtUpperBound } from '../../../../../referralLeads.service.js';

const ALL_TOOLS = [
  countInterviews, listInterviews, countOffers, listOffers,
  countPlacements, listPlacements, getHiringFunnel, listReferralLeads,
];

const viewer = (...perms) => ({ id: 'v1', _id: 'v1', authContext: { permissions: new Set(perms) } });
const ctxWith = (deps, user = viewer('candidates.read')) => ({ user, requestId: 'r', deps });
const paged = (totalResults, results = []) => ({ totalResults, results, page: 1, totalPages: 1 });

/** Fake User model: find(filter).select().limit().lean() → rows; filters land in `seen`. */
const fakeUsers = (rows, seen = []) => ({
  find: (filter) => { seen.push(filter); return { select: () => ({ limit: () => ({ lean: async () => rows }) }) }; },
});
/** Fake Employee model: distinct(field, match) → ids; calls land in `seen`. */
const fakeLeads = (ids, seen = []) => ({ distinct: async (field, match) => { seen.push({ field, match }); return ids; } });
const noLookup = {
  User: { find: () => assert.fail('must not look up users') },
  Employee: { distinct: () => assert.fail('must not look up leads') },
};
const AGENT_ID = '64b000000000000000000009';

describe('hiring tools — fail closed', () => {
  const failDeps = {
    queryMeetings: () => assert.fail('called'), queryOffers: () => assert.fail('called'),
    queryPlacements: () => assert.fail('called'), fetchHiringTunnelSnapshot: () => assert.fail('called'),
    searchReferralLeads: () => assert.fail('called'), canSeeAllReferralLeads: () => assert.fail('called'),
  };
  for (const tool of ALL_TOOLS) {
    it(`${tool.name} refuses to run without a user id (the services treat a missing user as unscoped)`, async () => {
      await assert.rejects(() => tool.execute({}, { user: {}, deps: failDeps }), /authenticated user/);
    });
  }
  it('covers all 8 hiring tools', () => assert.equal(ALL_TOOLS.length, 8));
});

describe('count_interviews', () => {
  it('passes the viewer to queryMeetings and returns status + result breakdowns', async () => {
    const seen = [];
    const out = await countInterviews.execute(
      { filters: { interviewer: 'Asha', result: 'selected' } },
      ctxWith({
        queryMeetings: async (filter, options, user) => {
          seen.push({ filter, options, user });
          return paged(JSON.stringify(filter).includes('"cancelled"') ? 1 : 4);
        },
      }),
    );
    assert.equal(seen.length, 1 + 3 + 3);
    assert.ok(seen.every((s) => s.user.id === 'v1' && s.options.limit === 1));
    assert.equal(out.total, 4);
    assert.deepEqual(Object.keys(out.byStatus), ['scheduled', 'ended', 'cancelled']);
    assert.deepEqual(Object.keys(out.byResult), ['pending', 'selected', 'rejected']);
  });

  it('matches the interviewer on the recruiter OR any panel agent, and the result exactly', () => {
    const f = interviewMongoFilter({ interviewer: 'Asha', result: 'rejected', scheduledBetween: { from: '2026-09-01', to: '2026-09-30' } });
    const clauses = JSON.stringify(f);
    assert.match(clauses, /"recruiter.name"/);
    assert.match(clauses, /"agents.name"/);
    assert.match(clauses, /"interviewResult":"rejected"/);
    const dates = f.$and.find((c) => c.scheduledAt).scheduledAt;
    assert.equal(dates.$gte.toISOString(), '2026-08-31T18:30:00.000Z'); // IST midnight of 09-01
    assert.equal(dates.$lte.toISOString(), '2026-09-30T18:29:59.999Z'); // IST end of 09-30
  });

  it('rejects a malformed day instead of querying', async () => {
    await assert.rejects(
      () => countInterviews.execute({ filters: { scheduledBetween: { from: '09/01/2026' } } }, ctxWith({ queryMeetings: async () => paged(0) })),
      /YYYY-MM-DD/,
    );
  });

  it('rejects an impossible day and a reversed window instead of querying', async () => {
    const deps = { queryMeetings: async () => assert.fail('must not query') };
    await assert.rejects(
      () => countInterviews.execute({ filters: { scheduledBetween: { from: '2026-02-30' } } }, ctxWith(deps)),
      /Invalid date '2026-02-30'/,
    );
    await assert.rejects(
      () => countInterviews.execute({ filters: { scheduledBetween: { from: '2026-09-30', to: '2026-09-01' } } }, ctxWith(deps)),
      /from is after to/,
    );
  });

  it('"interviews today" covers the IST day, not the UTC day', () => {
    const f = interviewMongoFilter({ scheduledBetween: { from: '2026-09-29', to: '2026-09-29' } });
    const { $gte, $lte } = f.$and.find((c) => c.scheduledAt).scheduledAt;
    const at = (iso) => new Date(iso) >= $gte && new Date(iso) <= $lte;
    assert.equal(at('2026-09-28T19:00:00.000Z'), true); // 00:30 IST on 09-29
    assert.equal(at('2026-09-29T20:00:00.000Z'), false); // 01:30 IST on 09-30
  });
});

describe('list_interviews', () => {
  it('maps rows and lists the whole panel', async () => {
    let options;
    const out = await listInterviews.execute(
      { filters: { candidate: 'Ravi' }, limit: 5 },
      ctxWith({
        queryMeetings: async (_f, o) => {
          options = o;
          return paged(1, [{
            id: 'm1', title: 'Round 1', candidate: { name: 'Ravi Kumar' }, jobPosition: 'QA',
            recruiter: { name: 'Asha' }, agents: [{ name: 'Asha' }, { name: 'Vikram' }],
            scheduledAt: '2026-09-29T10:00:00.000Z', status: 'scheduled', interviewResult: 'pending',
          }]);
        },
      }),
    );
    assert.equal(options.sortBy, 'scheduledAt:desc');
    assert.equal(out.records[0].interviewers, 'Asha (recruiter), Vikram');
    assert.equal(out.records[0].candidate, 'Ravi Kumar');
    assert.equal(out.records[0].result, 'pending');
  });
});

describe('count_offers', () => {
  it('breaks down by every offer status and turns createdBetween into the service window', async () => {
    const seen = [];
    const out = await countOffers.execute(
      { filters: { status: 'Accepted', createdBetween: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxWith({ queryOffers: async (filter) => { seen.push(filter); return paged(filter.status === 'Accepted' ? 2 : 1); } }),
    );
    assert.equal(out.total, 2);
    assert.deepEqual(Object.keys(out.byStatus), ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected']);
    assert.equal(seen[0].createdFrom, '2026-08-31T18:30:00.000Z');
    assert.equal(seen[0].createdTo, '2026-09-30T18:29:59.999Z');
  });
});

describe('list_offers — B1 compensation gate', () => {
  const offerDoc = {
    _id: 'o1', offerCode: 'OF-1', status: 'Sent', candidate: { fullName: 'Ravi Kumar' }, job: { title: 'QA' },
    ctcBreakdown: { gross: 900000, currency: 'INR' }, offerLetterUrl: 'https://s3/letter.pdf', rejectionReason: 'x',
  };
  const deps = { queryOffers: async () => paged(1, [offerDoc]) };

  it('hides CTC from a viewer who can only read offers', async () => {
    const out = await listOffers.execute({}, ctxWith(deps, viewer('candidates.read')));
    assert.equal(out.compensationHidden, true);
    assert.equal('ctc' in out.records[0], false);
  });

  it('shows CTC to a viewer who can edit offers (the Offer Letter Generator gate)', async () => {
    const out = await listOffers.execute({}, ctxWith(deps, viewer('offers.edit')));
    assert.equal(out.compensationHidden, undefined);
    assert.deepEqual(out.records[0].ctc, { gross: 900000, currency: 'INR' });
  });

  it('never returns the offer letter link or the rejection reason', async () => {
    const out = await listOffers.execute({}, ctxWith(deps, viewer('offers.manage')));
    const json = JSON.stringify(out);
    assert.doesNotMatch(json, /letter\.pdf|rejectionReason|offerLetterUrl/);
  });
});

describe('count_placements', () => {
  it('leaves Cancelled out of the total by default but shows it in the breakdown', async () => {
    const seen = [];
    const out = await countPlacements.execute(
      {},
      ctxWith({ queryPlacements: async (filter) => { seen.push(filter); return paged(3); } }),
    );
    assert.equal(seen[0].status, 'Pending,Onboarding,Joined,Deferred');
    assert.ok('Cancelled' in out.byStatus);
  });

  it('only breaks a stage queue down by the statuses that queue narrows by', async () => {
    const out = await countPlacements.execute(
      { filters: { stage: 'preBoarding' } },
      ctxWith({ queryPlacements: async () => paged(1) }),
    );
    assert.deepEqual(Object.keys(out.byStatus), ['Pending', 'Deferred', 'Cancelled']);
  });

  it('counts "joined this month" as status Joined with a joining-date window', async () => {
    let first;
    await countPlacements.execute(
      { filters: { status: 'Joined', joiningBetween: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxWith({ queryPlacements: async (filter) => { if (!first) first = filter; return paged(1); } }),
    );
    assert.equal(first.status, 'Joined');
    assert.equal(first.joiningFrom, '2026-08-31T18:30:00.000Z');
  });
});

describe('list_placements', () => {
  it('returns placement rows without CTC', async () => {
    const out = await listPlacements.execute(
      {},
      ctxWith({
        queryPlacements: async () => paged(1, [{
          _id: 'p1', status: 'Joined', candidate: { fullName: 'Meera' }, job: { title: 'QA' },
          offer: { offerCode: 'OF-2', ctcBreakdown: { gross: 1 } }, backgroundVerification: { status: 'Verified' },
        }]),
      }),
    );
    assert.equal(out.records[0].bgvStatus, 'Verified');
    assert.doesNotMatch(JSON.stringify(out), /ctc/i);
  });
});

describe('get_hiring_funnel', () => {
  it('reports a missing permission as an error', async () => {
    const out = await getHiringFunnel.execute({}, ctxWith({
      fetchHiringTunnelSnapshot: async () => ({ forbidden: true, reason: 'Missing candidates.read' }),
    }));
    assert.equal(out.error, 'Missing candidates.read');
  });

  it('passes the window as the page query and drops the hire name lists', async () => {
    let query;
    const out = await getHiringFunnel.execute(
      { filters: { referredBetween: { from: '2026-09-01' } } },
      ctxWith({
        fetchHiringTunnelSnapshot: async (args) => {
          query = args.query;
          return {
            stats: { totalReferrals: 10, conversionRate: 20, paidHiresList: [{ name: 'X' }], pipelineCounts: { applied: 4 } },
            buckets: { refer_leads: { label: 'Referral leads', count: 10, source: 's' }, pre_boarding: { label: 'Pre-boarding', count: 1, concurrent: true, source: 's' } },
          };
        },
      }),
    );
    assert.deepEqual(query, { from: '2026-08-31T18:30:00.000Z' });
    assert.equal(out.total, 10);
    assert.deepEqual(out.buckets.pre_boarding, { label: 'Pre-boarding', count: 1, concurrent: true });
    assert.doesNotMatch(JSON.stringify(out), /paidHiresList/);
  });
});

describe('list_referral_leads', () => {
  const lead = {
    id: 'c1', fullName: 'Khushi Parmar', referredBy: { name: 'Sami Shaikh' }, salesAgent: { name: 'Neha' },
    job: { title: 'QA' }, referralPipelineStatus: 'applied', referralContext: 'JOB_APPLY', referredAt: '2026-09-01',
  };

  it('answers "who referred X" through the page search', async () => {
    let seen;
    const out = await listReferralLeads.execute(
      { filters: { candidate: 'Khushi' } },
      ctxWith({ searchReferralLeads: async (user, query) => { seen = { user, query }; return { total: 1, results: [lead] }; } }),
    );
    assert.equal(seen.user.id, 'v1');
    assert.equal(seen.query.search, 'Khushi');
    assert.equal(out.records[0].referredBy, 'Sami Shaikh');
    assert.equal(out.records[0].salesAgent, 'Neha');
  });

  it('resolves a sales agent name to one user id, the key the page itself sends', async () => {
    let query;
    const leadCalls = [];
    const userCalls = [];
    await listReferralLeads.execute(
      { filters: { salesAgent: 'Neha Rao' } },
      ctxWith({
        canSeeAllReferralLeads: async () => true,
        Employee: fakeLeads([AGENT_ID, 'u8'], leadCalls),
        User: fakeUsers([{ _id: AGENT_ID, name: 'Neha Rao', status: 'active' }, { _id: 'u8', name: 'Neha Raonak', status: 'active' }], userCalls),
        searchReferralLeads: async (_u, q) => { query = q; return { total: 0, results: [] }; },
      }),
    );
    assert.equal(query.salesAgentUserId, AGENT_ID);
    // F1b: only users who are the sales agent on some referral lead are searched.
    assert.equal(leadCalls[0].field, 'currentSalesAgentUserId');
    assert.deepEqual(leadCalls[0].match.referredByUserId, { $exists: true, $ne: null });
    assert.deepEqual(userCalls[0]._id, { $in: [AGENT_ID, 'u8'] });
    // F2: the service's own filter builder (applyNewFilters) narrows on exactly this key.
    assert.equal(String(applyNewFilters(query).currentSalesAgentUserId), AGENT_ID);
  });

  it('resolves a referrer only among users who referred some lead', async () => {
    const leadCalls = [];
    let query;
    await listReferralLeads.execute(
      { filters: { referrer: 'Sami Shaikh' } },
      ctxWith({
        canSeeAllReferralLeads: async () => true,
        Employee: fakeLeads(['u2'], leadCalls),
        User: fakeUsers([{ _id: 'u2', name: 'Sami Shaikh', status: 'active' }]),
        searchReferralLeads: async (_u, q) => { query = q; return { total: 0, results: [] }; },
      }),
    );
    assert.equal(leadCalls[0].field, 'referredByUserId');
    assert.equal(query.referredByUserId, 'u2');
  });

  it('"unassigned" reaches the service as the page\'s unassigned key, which filters on no sales agent', async () => {
    let query;
    await listReferralLeads.execute(
      { filters: { unassigned: true } },
      ctxWith({ searchReferralLeads: async (_u, q) => { query = q; return { total: 0, results: [] }; } }),
    );
    assert.equal(query.unassigned, true);
    assert.equal(applyNewFilters(query).currentSalesAgentUserId, null);
  });

  it('asks which person when a name fits several — names only, never emails', async () => {
    const out = await listReferralLeads.execute(
      { filters: { referrer: 'Sam' } },
      ctxWith({
        canSeeAllReferralLeads: async () => true,
        Employee: fakeLeads(['a', 'b']),
        User: fakeUsers([
          { _id: 'a', name: 'Sami Shaikh', email: 'sami@x.test', status: 'active' },
          { _id: 'b', name: 'Sam Roy', email: 'sam@x.test', status: 'active' },
        ]),
        searchReferralLeads: async () => assert.fail('must not search'),
      }),
    );
    assert.equal(out.ambiguous, 'referrer');
    assert.deepEqual(out.matches, [{ name: 'Sami Shaikh' }, { name: 'Sam Roy' }]);
    assert.doesNotMatch(JSON.stringify(out), /@x\.test/);
    assert.equal(listReferralLeads.render(out), null);
  });

  it('reports an unknown person as notFound, not 0 leads — and render states no count', async () => {
    const out = await listReferralLeads.execute(
      { filters: { referrer: 'Nobody' } },
      ctxWith({
        canSeeAllReferralLeads: async () => true,
        Employee: fakeLeads(['u2']),
        User: fakeUsers([]),
        searchReferralLeads: async () => assert.fail('must not search'),
      }),
    );
    assert.equal(out.notFound, 'referrer');
    assert.equal(listReferralLeads.render(out), null);
  });

  it('is notFound without a user lookup when no lead has anyone in that role', async () => {
    const out = await listReferralLeads.execute(
      { filters: { salesAgent: 'Neha' } },
      ctxWith({
        canSeeAllReferralLeads: async () => true,
        Employee: fakeLeads([]),
        User: noLookup.User,
        searchReferralLeads: async () => assert.fail('must not search'),
      }),
    );
    assert.equal(out.notFound, 'salesAgent');
  });

  for (const key of ['referrer', 'salesAgent']) {
    it(`refuses another ${key} for a scoped viewer before any user lookup`, async () => {
      const out = await listReferralLeads.execute(
        { filters: { [key]: 'Sami Shaikh' } },
        ctxWith({
          ...noLookup,
          canSeeAllReferralLeads: async () => false,
          searchReferralLeads: async () => assert.fail('must not search'),
        }),
      );
      assert.match(out.error, /only see referral leads you referred/);
      assert.match(out.error, key === 'referrer' ? /another referrer/ : /another sales agent/);
    });
  }

  it('"my referrals" for a scoped viewer is self — no lookup — with a note on what the page shows', async () => {
    let query;
    const out = await listReferralLeads.execute(
      { filters: { referrer: 'me' } },
      ctxWith({
        ...noLookup,
        canSeeAllReferralLeads: async () => false,
        searchReferralLeads: async (_u, q) => { query = q; return { total: 2, results: [lead] }; },
      }),
    );
    assert.equal(query.referredByUserId, 'v1');
    assert.match(out.note, /sales agent for/);
    assert.equal(out.total, 2);
  });

  it('the viewer\'s own name counts as self, for sales agent too', async () => {
    let query;
    const self = { ...viewer('candidates.read'), name: 'Neha Rao', email: 'neha@x.test' };
    const out = await listReferralLeads.execute(
      { filters: { salesAgent: 'neha rao' } },
      ctxWith({
        ...noLookup,
        canSeeAllReferralLeads: async () => false,
        searchReferralLeads: async (_u, q) => { query = q; return { total: 0, results: [] }; },
      }, self),
    );
    assert.equal(query.salesAgentUserId, 'v1');
    assert.equal(out.note, undefined);
  });

  it('sends the claimed window as IST-bounded instants the service keeps exact', async () => {
    let query;
    await listReferralLeads.execute(
      { filters: { claimedBetween: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxWith({ searchReferralLeads: async (_u, q) => { query = q; return { total: 0, results: [] }; } }),
    );
    assert.equal(query.from, '2026-08-31T18:30:00.000Z');
    assert.equal(query.to, '2026-09-30T18:29:59.999Z');
    assert.equal(referredAtUpperBound(query.to).toISOString(), '2026-09-30T18:29:59.999Z');
  });

  it('referralWindow shares the day validator', () => {
    assert.throws(() => referralWindow({ from: '2026-02-30' }), /Invalid date/);
    assert.throws(() => referralWindow({ from: '2026-09-30', to: '2026-09-01' }), /from is after to/);
    assert.deepEqual(referralWindow(undefined), {});
  });
});

describe('referralLeads.service referredAtUpperBound', () => {
  it('keeps the page\'s plain-day behaviour: end of that day, server-local', () => {
    const expected = new Date('2026-09-30');
    expected.setHours(23, 59, 59, 999);
    assert.equal(referredAtUpperBound('2026-09-30').getTime(), expected.getTime());
  });

  it('takes a full ISO instant as-is', () => {
    assert.equal(referredAtUpperBound('2026-09-30T18:29:59.999Z').toISOString(), '2026-09-30T18:29:59.999Z');
  });
});

describe('hiring matchesTurn', () => {
  it('opens on hiring nouns', () => {
    for (const q of [
      'how many interviews are scheduled today', 'list pending offers', 'how many placements joined this month',
      'how many in pre-boarding', 'show me the hiring funnel', 'who reffered Khushi Parmar?',
      'which candidates did Sami refer', 'who is the top referrer',
      'who is joining next week', 'placements joining this month', 'who is joining today?',
      'how many candidates are joining tomorrow', 'what is her joining date',
    ]) assert.equal(matchesTurn(q), true, q);
  });

  it('stays closed for un-migrated domains and unrelated verbs', () => {
    for (const q of [
      'how many meetings do I have today', 'show my tasks', 'who is on leave today', 'my attendance this week',
      'do we offer health insurance', 'how many employees do we have', 'please refer to the leave policy',
      "who is joining today's standup", 'is Rahul joining tomorrow',
    ]) assert.equal(matchesTurn(q), false, q);
  });
});
