import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClassifierPrompt,
  parseClassifierResponse,
  classifyRole,
  CLASSIFIER_DEFAULT,
} from '../roleClassifier.js';

describe('buildClassifierPrompt', () => {
  it('lists all five roles + alias hints', () => {
    const sys = buildClassifierPrompt({ lastEntities: null, lastListing: null }).system;
    for (const r of ['Employee', 'Agent', 'Recruiter', 'Administrator', 'Student']) {
      assert.match(sys, new RegExp(r));
    }
    assert.match(sys, /candidate.*Employee/i);
    assert.match(sys, /sales agent.*Agent/i);
    assert.match(sys, /retired|resigned/i);
  });

  it('mentions continuation flag when lastListing present', () => {
    const sys = buildClassifierPrompt({
      lastEntities: null,
      lastListing: { role: 'Employee', employmentScope: 'active', total: 112 },
    }).system;
    assert.match(sys, /continuation/i);
    assert.match(sys, /Employee/);
  });

  it('includes lastEntities when present', () => {
    const sys = buildClassifierPrompt({
      lastEntities: { person: 'Harsh', role: 'Agent' },
      lastListing: null,
    }).system;
    assert.match(sys, /Harsh/);
    assert.match(sys, /Agent/);
  });
});

describe('parseClassifierResponse', () => {
  it('parses valid JSON', () => {
    const out = parseClassifierResponse(JSON.stringify({
      role: 'Employee', employmentScope: 'active', search: null,
      continuation: false, ambiguous: false, confidence: 0.9, clarifyingQuestion: null,
    }));
    assert.equal(out.role, 'Employee');
    assert.equal(out.confidence, 0.9);
    assert.equal(out.ambiguous, false);
  });

  it('returns ambiguous default on invalid JSON', () => {
    const out = parseClassifierResponse('not json {{{');
    assert.equal(out.ambiguous, true);
    assert.ok(out.clarifyingQuestion);
  });

  it('returns ambiguous default on JSON without role', () => {
    const out = parseClassifierResponse('{}');
    assert.equal(out.ambiguous, true);
  });

  it('rejects unknown role values', () => {
    const out = parseClassifierResponse(JSON.stringify({ role: 'Wizard', confidence: 0.9 }));
    assert.equal(out.ambiguous, true);
  });

  it('forces ambiguous when confidence < 0.6', () => {
    const out = parseClassifierResponse(JSON.stringify({
      role: 'Employee', confidence: 0.4, ambiguous: false,
    }));
    assert.equal(out.ambiguous, true);
  });

  it('clamps unknown employmentScope to active', () => {
    const out = parseClassifierResponse(JSON.stringify({
      role: 'Employee', employmentScope: 'gibberish', confidence: 0.9,
    }));
    assert.equal(out.employmentScope, 'active');
  });

  it('forces continuation=false when role is null/missing (defensive)', () => {
    const out = parseClassifierResponse(JSON.stringify({
      role: null, continuation: true, ambiguous: false, confidence: 0.9,
    }));
    assert.equal(out.continuation, false);
    assert.equal(out.ambiguous, true, 'should fall back to ambiguous when continuation has no role');
  });
});

describe('classifyRole', () => {
  function mockOpenAI(responseContent) {
    return {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: responseContent } }] }),
        },
      },
    };
  }

  it('returns parsed result on success', async () => {
    const openai = mockOpenAI(JSON.stringify({
      role: 'Agent', employmentScope: 'active', confidence: 0.95,
    }));
    const out = await classifyRole({ openai, userTurn: 'list agents', history: [], lastEntities: null, lastListing: null });
    assert.equal(out.role, 'Agent');
  });

  it('returns CLASSIFIER_DEFAULT on OpenAI throw', async () => {
    const openai = {
      chat: { completions: { create: async () => { throw new Error('rate limit'); } } },
    };
    const out = await classifyRole({ openai, userTurn: 'x', history: [], lastEntities: null, lastListing: null });
    assert.equal(out.ambiguous, true);
    assert.equal(out.clarifyingQuestion, CLASSIFIER_DEFAULT.clarifyingQuestion);
  });

  it('continuation=true is preserved when classifier returns it', async () => {
    const openai = mockOpenAI(JSON.stringify({
      role: 'Employee', continuation: true, ambiguous: false, confidence: 0.9,
    }));
    const out = await classifyRole({
      openai,
      userTurn: 'next',
      history: [],
      lastEntities: null,
      lastListing: { role: 'Employee', employmentScope: 'active', total: 112 },
    });
    assert.equal(out.continuation, true);
    assert.equal(out.role, 'Employee');
  });
});
