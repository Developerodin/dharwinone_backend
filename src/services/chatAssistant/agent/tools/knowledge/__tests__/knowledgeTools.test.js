import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searchKnowledgeBase, { MAX_ANSWER_CHARS } from '../searchKnowledgeBase.tool.js';

function ctxWith({ findVoiceAgent, queryKb }, user = { id: 'u1', adminId: 'admin1' }) {
  return { user, requestId: 'r', deps: { findVoiceAgent, queryKb } };
}

describe('search_knowledge_base', () => {
  it("queries the KB of the viewer's admin voice agent (no adminId walk)", async () => {
    const seen = {};
    const out = await searchKnowledgeBase.execute({ query: 'leave policy' }, ctxWith({
      findVoiceAgent: async (owner) => { seen.owner = owner; return { _id: 'agent1' }; },
      queryKb: async (agentId, q) => { seen.agentId = agentId; seen.q = q; return { answer: '20 days a year.', fallback: false }; },
    }));
    assert.deepEqual(seen, { owner: 'admin1', agentId: 'agent1', q: 'leave policy' });
    assert.deepEqual(out, { found: true, answer: '20 days a year.' });
  });

  it('falls back to the viewer id when they have no adminId', async () => {
    let owner;
    await searchKnowledgeBase.execute({ query: 'dress code' }, ctxWith({
      findVoiceAgent: async (o) => { owner = o; return null; },
      queryKb: async () => assert.fail('no agent means no query'),
    }, { id: 'self1' }));
    assert.equal(owner, 'self1');
  });

  it('reports no configured KB and KB misses as found:false', async () => {
    const none = await searchKnowledgeBase.execute({ query: 'x policy' }, ctxWith({ findVoiceAgent: async () => null }));
    assert.deepEqual(none, { found: false, notConfigured: true, answer: null });
    const miss = await searchKnowledgeBase.execute({ query: 'x policy' }, ctxWith({
      findVoiceAgent: async () => ({ _id: 'a' }),
      queryKb: async () => ({ answer: 'no info', fallback: true }),
    }));
    assert.deepEqual(miss, { found: false, answer: null });
  });

  it('bounds the answer size', async () => {
    const out = await searchKnowledgeBase.execute({ query: 'handbook' }, ctxWith({
      findVoiceAgent: async () => ({ _id: 'a' }),
      queryKb: async () => ({ answer: 'x'.repeat(5000), fallback: false }),
    }));
    assert.equal(out.answer.length, MAX_ANSWER_CHARS + 1);
  });

  it('turns a KB error into unavailable instead of throwing', async () => {
    const out = await searchKnowledgeBase.execute({ query: 'sop' }, ctxWith({
      findVoiceAgent: async () => ({ _id: 'a' }),
      queryKb: async () => { throw new Error('Embeddings unavailable'); },
    }));
    assert.equal(out.found, false);
    assert.equal(out.unavailable, true);
  });
});
