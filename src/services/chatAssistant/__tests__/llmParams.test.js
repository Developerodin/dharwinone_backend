import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { llmParams } from '../llmParams.js';

describe('llmParams', () => {
  it('keeps temperature and max_tokens for gpt-4o family', () => {
    assert.deepEqual(llmParams('gpt-4o-mini', { temperature: 0.1, maxTokens: 256 }), {
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 256,
    });
  });

  it('uses max_completion_tokens, drops temperature and sets reasoning_effort none for reasoning models', () => {
    assert.deepEqual(llmParams('gpt-6-luna', { temperature: 0.55, maxTokens: 1500 }), {
      model: 'gpt-6-luna',
      max_completion_tokens: 1500,
      reasoning_effort: 'none',
    });
  });

  it('passes a reasoning effort through with token headroom', () => {
    assert.deepEqual(llmParams('gpt-6-luna', { maxTokens: 1500, reasoningEffort: 'medium' }), {
      model: 'gpt-6-luna',
      max_completion_tokens: 5500,
      reasoning_effort: 'medium',
    });
  });

  it('ignores reasoning effort for non-reasoning models', () => {
    assert.equal(llmParams('gpt-4o', { maxTokens: 10, reasoningEffort: 'high' }).reasoning_effort, undefined);
  });

  it('treats gpt-5 and o-series as reasoning models', () => {
    assert.equal(llmParams('gpt-5.4-mini', { maxTokens: 10 }).max_completion_tokens, 10);
    assert.equal(llmParams('o4-mini', { maxTokens: 10 }).reasoning_effort, 'none');
  });
});
