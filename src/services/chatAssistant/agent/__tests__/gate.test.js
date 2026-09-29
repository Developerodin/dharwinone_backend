import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryAgentTurn, fallbackReply, SAGE_REPLIES } from '../gate.js';

const user = { id: 'u1' };
const jobQ = [{ role: 'user', content: 'how many open jobs' }];
const answer = {
  reply: 'There are 3 open jobs.',
  blocks: [{ type: 'text', md: 'x' }],
  meta: { steps: 1, toolCalls: ['count_jobs'], ms: 5 },
  ledgerEntry: { at: new Date(), calls: [{ tool: 'count_jobs', args: {}, total: 3 }] },
};

function deps(over = {}) {
  const calls = { load: 0, run: 0, append: 0, entries: [], runArgs: null };
  const d = {
    loadMemDoc: async () => { calls.load += 1; return { agentLedger: [] }; },
    run: async (args) => { calls.run += 1; calls.runArgs = args; args.onOutcome('answer'); return answer; },
    appendLedger: async ({ entry }) => { calls.append += 1; calls.entries.push(entry); },
    ...over,
  };
  return { d, calls };
}

/** A fake runAgent that reports `outcome` and answers nothing, like the real one. */
const unanswered = (outcome) => async ({ onOutcome }) => { onOutcome(outcome); return null; };

describe('fallbackReply', () => {
  it('maps each non-answer outcome to its fixed reply', () => {
    assert.equal(fallbackReply('handoff'), SAGE_REPLIES.handoff);
    assert.equal(fallbackReply('untooled_number'), SAGE_REPLIES.untooledNumber);
    for (const o of ['error', 'deadline', 'empty', 'repeated_tool_failure', 'anything-else']) {
      assert.equal(fallbackReply(o), SAGE_REPLIES.unavailable, o);
    }
  });

  it('no fixed reply carries a digit (numbers only ever come from a tool)', () => {
    for (const reply of Object.values(SAGE_REPLIES)) assert.equal(/\d/.test(reply), false, reply);
  });
});

describe('tryAgentTurn', () => {
  it('runs every turn through the agent with the loaded memDoc, and persists a tool-backed ledger entry', async () => {
    const { d, calls } = deps();
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, requestId: 'r1', deps: d });
    assert.deepEqual(out, { reply: answer.reply, blocks: answer.blocks, meta: answer.meta, outcome: 'answer' });
    assert.equal(calls.run, 1);
    assert.deepEqual(calls.runArgs.memDoc, { agentLedger: [] });
    assert.equal(calls.runArgs.requestId, 'r1');
    assert.deepEqual(calls.entries, [answer.ledgerEntry]);
  });

  it('a greeting-style turn with no tool call is answered and writes no ledger entry', async () => {
    const hi = { reply: 'Hi! How can I help?', blocks: [], meta: { steps: 1, toolCalls: [], ms: 3 }, ledgerEntry: { at: new Date(), calls: [] } };
    const { d, calls } = deps({ run: async ({ onOutcome }) => { onOutcome('answer'); return hi; } });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: [{ role: 'user', content: 'hi' }], deps: d });
    assert.equal(out.reply, hi.reply);
    assert.equal(out.outcome, 'answer');
    assert.equal(calls.append, 0);
  });

  it('handoff → the fixed "can\'t answer that yet" reply, no blocks, no ledger write', async () => {
    const { d, calls } = deps({ run: unanswered('handoff') });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.deepEqual(out, { reply: SAGE_REPLIES.handoff, blocks: [], meta: null, outcome: 'handoff' });
    assert.equal(calls.append, 0);
  });

  it('an untooled number → its own fixed reply', async () => {
    const { d } = deps({ run: unanswered('untooled_number') });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.reply, SAGE_REPLIES.untooledNumber);
    assert.equal(out.outcome, 'untooled_number');
  });

  it('deadline / empty / repeated failure → the fixed "couldn\'t answer right now" reply', async () => {
    for (const outcome of ['deadline', 'empty', 'repeated_tool_failure', 'error']) {
      const { d } = deps({ run: unanswered(outcome) });
      // eslint-disable-next-line no-await-in-loop
      const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
      assert.equal(out.reply, SAGE_REPLIES.unavailable, outcome);
      assert.equal(out.outcome, outcome);
    }
  });

  it('a throwing runAgent never goes dark: outcome error, fixed reply', async () => {
    const { d } = deps({ run: async () => { throw new Error('boom'); } });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.deepEqual(out, { reply: SAGE_REPLIES.unavailable, blocks: [], meta: null, outcome: 'error' });
  });

  it('a throwing memory read never goes dark and never runs the agent', async () => {
    const { d, calls } = deps({ loadMemDoc: async () => { throw new Error('db down'); } });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.reply, SAGE_REPLIES.unavailable);
    assert.equal(calls.run, 0);
  });

  it('a throwing ledger write still returns the answer', async () => {
    const { d } = deps({ appendLedger: async () => { throw new Error('write failed'); } });
    const out = await tryAgentTurn({ user, adminId: 'a1', history: jobQ, deps: d });
    assert.equal(out.reply, answer.reply);
    assert.equal(out.outcome, 'answer');
  });

  it('a user with no id still gets a turn: the default loader reads no memDoc', async () => {
    const { d, calls } = deps();
    delete d.loadMemDoc;
    const out = await tryAgentTurn({ user: {}, adminId: undefined, history: jobQ, deps: d });
    assert.equal(out.outcome, 'answer');
    assert.equal(calls.runArgs.memDoc, null);
  });
});
