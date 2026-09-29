// chatAssistant.service.js → agent/gate.js with a fake runAgent and no DB: every
// turn comes back in the { reply, blocks, meta } envelope, and a turn the agent
// does not answer gets its fixed reply instead of going dark or throwing.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../../../config/config.js';
import { sendMessage, streamMessage } from '../../../chatAssistant.service.js';
import { SAGE_REPLIES } from '../gate.js';

const user = { id: 'u1', adminId: 'a1' };
const messages = [{ role: 'user', content: 'how many open jobs' }];
const answer = {
  reply: 'There are 3 open jobs.',
  blocks: [{ type: 'text', md: 'x' }],
  meta: { steps: 1, toolCalls: ['count_jobs'], ms: 12 },
  ledgerEntry: { at: new Date(), calls: [] },
};

/** No DB: memory read and ledger write are stubbed; `run` stands in for runAgent. */
const depsWith = (run) => ({ loadMemDoc: async () => null, appendLedger: async () => {}, run });
const reports = (outcome) => async ({ onOutcome }) => { onOutcome(outcome); return null; };

const FALLBACK_META = { kind: null, entityType: null, queryId: null, total: null, deterministic: false, tookMs: null };

before(() => {
  // sendMessage refuses to run without a key; the fake runAgent never calls OpenAI.
  if (!config.openai.apiKey) config.openai.apiKey = 'test-key';
});

describe('sendMessage', () => {
  it('an answered turn returns the agent reply, blocks and meta in the envelope', async () => {
    const out = await sendMessage({ messages, user, requestId: 'r1', deps: depsWith(async () => answer) });
    assert.deepEqual(out, {
      reply: answer.reply,
      blocks: answer.blocks,
      meta: { kind: 'jobs', entityType: 'jobs', queryId: null, total: null, deterministic: false, tookMs: 12 },
    });
  });

  it('handoff → the fixed "can\'t answer that yet" reply in the normal shape', async () => {
    const out = await sendMessage({ messages, user, deps: depsWith(reports('handoff')) });
    assert.deepEqual(out, { reply: SAGE_REPLIES.handoff, blocks: [], meta: FALLBACK_META });
  });

  it('runAgent returning null with no outcome → the fixed "couldn\'t answer right now" reply', async () => {
    const out = await sendMessage({ messages, user, deps: depsWith(async () => null) });
    assert.deepEqual(out, { reply: SAGE_REPLIES.unavailable, blocks: [], meta: FALLBACK_META });
  });

  it('a throwing runAgent → the fixed reply, never a thrown error', async () => {
    const out = await sendMessage({ messages, user, deps: depsWith(async () => { throw new Error('boom'); }) });
    assert.deepEqual(out, { reply: SAGE_REPLIES.unavailable, blocks: [], meta: FALLBACK_META });
  });

  it('an untooled number → its own fixed reply', async () => {
    const out = await sendMessage({ messages, user, deps: depsWith(reports('untooled_number')) });
    assert.equal(out.reply, SAGE_REPLIES.untooledNumber);
  });

  it('passes only the last 6 non-empty messages to the agent', async () => {
    let seen;
    const many = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await sendMessage({ messages: [...many, { role: 'user', content: '   ' }], user, deps: depsWith(async (a) => { seen = a.history; return answer; }) });
    assert.deepEqual(seen.map((m) => m.content), ['m4', 'm5', 'm6', 'm7', 'm8']);
  });
});

describe('streamMessage', () => {
  async function stream(run) {
    const tokens = [];
    let done;
    await streamMessage({
      messages,
      user,
      requestId: 'r2',
      onToken: (t) => tokens.push(t),
      onDone: (env) => { done = env; },
      deps: depsWith(run),
    });
    return { tokens, done };
  }

  it('sends the whole answer as one token, then the envelope on done', async () => {
    const { tokens, done } = await stream(async () => answer);
    assert.deepEqual(tokens, [answer.reply]);
    assert.equal(done.reply, answer.reply);
    assert.deepEqual(done.blocks, answer.blocks);
    assert.equal(done.meta.kind, 'jobs');
  });

  it('handoff streams the fixed reply and still ends with done', async () => {
    const { tokens, done } = await stream(reports('handoff'));
    assert.deepEqual(tokens, [SAGE_REPLIES.handoff]);
    assert.deepEqual(done, { reply: SAGE_REPLIES.handoff, blocks: [], meta: FALLBACK_META });
  });

  it('a throwing runAgent streams the fixed reply instead of an error', async () => {
    const { tokens, done } = await stream(async () => { throw new Error('boom'); });
    assert.deepEqual(tokens, [SAGE_REPLIES.unavailable]);
    assert.equal(done.reply, SAGE_REPLIES.unavailable);
  });
});
