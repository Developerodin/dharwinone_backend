import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentTurn, hasRecentAgentTurn, hasPendingPick, tryAgentTurn, AGENT_TURN_WINDOW_MS } from '../gate.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const ledgerAt = (msAgo) => ({ agentLedger: [{ at: new Date(NOW.getTime() - msAgo), calls: [] }] });

describe('isAgentTurn', () => {
  it('takes a message with a job noun', () => {
    assert.equal(isAgentTurn('how many open jobs do we have', null, NOW), true);
    assert.equal(isAgentTurn('how many AI roles are there', null, NOW), true);
  });

  it('takes a salary ranking question', () => {
    assert.equal(isAgentTurn('top 5 highest paying positions', null, NOW), true);
  });

  it('takes a noun-less follow-up when the agent answered under 30 minutes ago', () => {
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(5 * 60 * 1000), NOW), true);
  });

  it('skips a noun-less follow-up when the last agent turn is stale', () => {
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(AGENT_TURN_WINDOW_MS), NOW), false);
    assert.equal(isAgentTurn('and the remote ones?', ledgerAt(2 * 60 * 60 * 1000), NOW), false);
  });

  it('skips a non-job message with no ledger', () => {
    assert.equal(isAgentTurn('who is on leave today', null, NOW), false);
    assert.equal(isAgentTurn('who is on leave today', { agentLedger: [] }, NOW), false);
    assert.equal(isAgentTurn("show me today's attendance summary", {}, NOW), false);
  });

  it('pins the RBAC-phrasing behavior change: "list user roles and permissions" now matches the people domain (review fix round 1, m-3)', () => {
    assert.equal(isAgentTurn('list user roles and permissions', {}, NOW), true);
  });
});

describe('hasRecentAgentTurn', () => {
  it('reads only the last ledger entry', () => {
    const memDoc = {
      agentLedger: [
        { at: new Date(NOW.getTime() - 60 * 1000), calls: [] },
        { at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000), calls: [] },
      ],
    };
    assert.equal(hasRecentAgentTurn(memDoc, NOW), false);
  });

  it('accepts a serialized timestamp and rejects a missing or bad one', () => {
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ at: new Date(NOW.getTime() - 1000).toISOString() }] }, NOW), true);
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ calls: [] }] }, NOW), false);
    assert.equal(hasRecentAgentTurn({ agentLedger: [{ at: 'not a date' }] }, NOW), false);
  });

  it('a handoff marker as the last entry closes the window', () => {
    const memDoc = {
      agentLedger: [
        { at: new Date(NOW.getTime() - 5 * 60 * 1000), calls: [{ tool: 'count_jobs', args: {}, total: 3 }] },
        { at: new Date(NOW.getTime() - 60 * 1000), handoff: true },
      ],
    };
    assert.equal(hasRecentAgentTurn(memDoc, NOW), false);
    assert.equal(isAgentTurn('and the remote ones?', memDoc, NOW), false);
  });
});

describe('hasPendingPick', () => {
  const fresh = new Date();
  it('is true while a job, title or entity pick is open', async () => {
    const title = { lastEntities: { pendingTitleDisambiguation: { query: 'Data Analyst', jobMatches: [{ kind: 'job' }], employeeMatches: [], createdAt: fresh } } };
    const job = { lastEntities: { pendingJobDisambiguation: { query: 'dev', matches: [{ jobId: 'j1' }], createdAt: fresh } } };
    const entity = { lastEntities: { pendingEntityDisambiguation: { query: 'x', matches: [{ kind: 'role' }], createdAt: fresh } } };
    assert.equal(await hasPendingPick('the job', title), true);
    assert.equal(await hasPendingPick('2', job), true);
    assert.equal(await hasPendingPick('the first one', entity), true);
  });

  it('(d) is true while a person disambiguation pick is open', async () => {
    const person = {
      lastEntities: {
        pendingPersonDisambiguation: {
          query: 'john',
          matches: [{ userId: 'u1', name: 'John Doe', roles: [] }],
          createdAt: fresh,
        },
      },
    };
    assert.equal(await hasPendingPick('1', person), true);
    assert.equal(await hasPendingPick('the first one', person), true);
  });

  it('ignores an expired pick', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const title = { lastEntities: { pendingTitleDisambiguation: { query: 'x', jobMatches: [{ kind: 'job' }], createdAt: stale } } };
    assert.equal(await hasPendingPick('the job', title), false);
  });

  it('leaves "what about jobs" to the title switch only when a designation is on the table', async () => {
    const withTitle = { lastEntities: { positionConversationState: { designation: 'Data Analyst' } } };
    assert.equal(await hasPendingPick('what about jobs', withTitle), true);
    assert.equal(await hasPendingPick('what about jobs', {}), false);
    assert.equal(await hasPendingPick('how many open jobs', withTitle), false);
  });
});

describe('tryAgentTurn', () => {
  const user = { id: 'u1' };
  const jobQ = [{ role: 'user', content: 'how many open jobs' }];
  const answer = {
    reply: 'There are 3 open jobs.',
    blocks: [],
    meta: { steps: 1, toolCalls: ['count_jobs'], ms: 5 },
    ledgerEntry: { at: new Date(), calls: [{ tool: 'count_jobs', args: {}, total: 3 }] },
  };

  function deps(over = {}) {
    const calls = { load: 0, access: 0, run: 0, append: 0, entries: [] };
    const d = {
      enabled: () => true,
      loadMemDoc: async () => { calls.load += 1; return null; },
      checkAccess: async () => { calls.access += 1; return { ok: true }; },
      pendingPick: async () => false,
      run: async () => { calls.run += 1; return answer; },
      appendLedger: async ({ entry }) => { calls.append += 1; calls.entries.push(entry); },
      now: () => NOW,
      ...over,
    };
    return { d, calls };
  }

  it('flag off → skip without any I/O', async () => {
    const { d, calls } = deps({ enabled: () => false });
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d }), { result: null, attempted: false });
    assert.deepEqual(calls, { load: 0, access: 0, run: 0, append: 0, entries: [] });
  });

  it('answers a gated turn and persists its ledger entry', async () => {
    const { d, calls } = deps();
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.result, answer);
    assert.equal(out.attempted, true);
    assert.equal(calls.append, 1);
  });

  it('access denied → skip, agent not run', async () => {
    const { d, calls } = deps({ checkAccess: async () => ({ ok: false }) });
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d }), { result: null, attempted: false });
    assert.equal(calls.run, 0);
  });

  it('pending pick → skip, agent not run', async () => {
    const { d, calls } = deps({ pendingPick: async () => true });
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: [{ role: 'user', content: 'the job' }], deps: d }), { result: null, attempted: false });
    assert.equal(calls.run, 0);
  });

  it('gate rejects a non-job turn at the entry, but the router fallback may try it', async () => {
    const leave = [{ role: 'user', content: 'who is on leave today' }];
    const entry = deps();
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: leave, deps: entry.d }), { result: null, attempted: false });
    assert.equal(entry.calls.run, 0);
    const fallback = deps();
    const out = await tryAgentTurn({ user, adminId: 'a1', history: leave, routerPicked: true, deps: fallback.d });
    assert.equal(fallback.calls.run, 1);
    assert.equal(out.attempted, true);
  });

  it('a handoff is still an attempt (router fallback must not retry)', async () => {
    const { d, calls } = deps({ run: async () => null });
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d }), { result: null, attempted: true });
    assert.equal(calls.append, 0);
  });

  it('a no-tool answer writes no ledger entry, so it cannot re-arm the window', async () => {
    const noTool = { ...answer, reply: 'MERN is a stack.', ledgerEntry: { at: NOW, calls: [] } };
    const { d, calls } = deps({ run: async () => noTool });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.result, noTool);
    assert.equal(calls.append, 0);
  });

  it('a handoff inside the recency window appends a closing marker', async () => {
    const open = ledgerAt(5 * 60 * 1000);
    const { d, calls } = deps({ loadMemDoc: async () => open, run: async () => null });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: [{ role: 'user', content: 'and on leave?' }], deps: d });
    assert.deepEqual(out, { result: null, attempted: true });
    assert.deepEqual(calls.entries, [{ at: NOW, handoff: true }]);
    assert.equal(hasRecentAgentTurn({ agentLedger: [...open.agentLedger, ...calls.entries] }, NOW), false);
  });

  it('a throwing memory read or ledger write never goes dark', async () => {
    const boom = deps({ loadMemDoc: async () => { throw new Error('db down'); } });
    assert.deepEqual(await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: boom.d }), { result: null, attempted: false });
    const ledgerFail = deps({ appendLedger: async () => { throw new Error('write failed'); } });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: ledgerFail.d });
    assert.equal(out.result, answer);
  });
});

// The people domain doesn't exist yet (a separate task builds it against this
// gate). These exercise the domain-generic mechanism end to end through a stub
// domain injected via deps.domains, standing in for a real migrated domain.
describe('tryAgentTurn — domain-generic gate', () => {
  const usersDomain = {
    domain: 'users',
    instructions: 'Users: user accounts and roles.',
    matchesTurn: (text) => /\busers?\b|\broles?\b/i.test(text),
    tools: [{ name: 'count_users', domain: 'users', access: { anyOf: ['users.read'] } }],
  };
  const withUsersRead = { id: 'u2', authContext: { permissions: new Set(['users.read']) } };
  const withoutUsersRead = { id: 'u3', authContext: { permissions: new Set(['jobs.read']) } };
  const usersQ = [{ role: 'user', content: 'how many users do we have' }];
  const stubAnswer = {
    reply: 'There are 3 users.',
    blocks: [],
    meta: { steps: 1, toolCalls: ['count_users'], ms: 5 },
    ledgerEntry: { at: NOW, calls: [{ tool: 'count_users', args: {}, total: 3 }] },
  };

  function stubDeps(over = {}) {
    const calls = { run: 0 };
    const d = {
      enabled: () => true,
      loadMemDoc: async () => null,
      domains: [usersDomain],
      pendingPick: async () => false,
      run: async () => { calls.run += 1; return stubAnswer; },
      appendLedger: async () => {},
      now: () => NOW,
      ...over,
    };
    return { d, calls };
  }

  it('(a) a users/roles turn reaches the agent when the user holds users.read', async () => {
    const { d, calls } = stubDeps();
    const out = await tryAgentTurn({ user: withUsersRead, adminId: 'a1', history: usersQ, deps: d });
    assert.equal(out.attempted, true);
    assert.equal(calls.run, 1);
  });

  it('(b) the same turn stays on the legacy pipeline when the user lacks users.read', async () => {
    const { d, calls } = stubDeps();
    const out = await tryAgentTurn({ user: withoutUsersRead, adminId: 'a1', history: usersQ, deps: d });
    assert.deepEqual(out, { result: null, attempted: false });
    assert.equal(calls.run, 0);
  });

  it('(c) a job turn still reaches the agent against the real registry, unchanged', async () => {
    const jobsUser = { id: 'u1', authContext: { permissions: new Set(['jobs.read']) } };
    const jobQ = [{ role: 'user', content: 'how many open jobs' }];
    let runCalls = 0;
    const d = {
      enabled: () => true,
      loadMemDoc: async () => null,
      pendingPick: async () => false,
      run: async () => { runCalls += 1; return stubAnswer; },
      appendLedger: async () => {},
      now: () => NOW,
    };
    const out = await tryAgentTurn({ user: jobsUser, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.attempted, true);
    assert.equal(runCalls, 1);
  });

  it('(e) an unmatched turn with no recent agent turn stays on the legacy pipeline', async () => {
    const { d, calls } = stubDeps();
    const out = await tryAgentTurn({
      user: withUsersRead,
      adminId: 'a1',
      history: [{ role: 'user', content: 'what is the weather today' }],
      deps: d,
    });
    assert.deepEqual(out, { result: null, attempted: false });
    assert.equal(calls.run, 0);
  });
});
