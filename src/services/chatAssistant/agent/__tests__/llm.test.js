import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../../../config/config.js';
import { step } from '../llm.js';

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        calls.push(req);
        return response;
      },
    },
  };
}

describe('llm.step', () => {
  let original;
  beforeEach(() => {
    original = { model: config.chatbot.model, reasoningEffort: config.chatbot.reasoningEffort };
    config.chatbot.model = 'test-model-from-config';
    config.chatbot.reasoningEffort = 'low';
  });
  afterEach(() => {
    config.chatbot.model = original.model;
    config.chatbot.reasoningEffort = original.reasoningEffort;
  });

  it('sends the Responses request shape with model and effort from config', async () => {
    const client = fakeClient({ output: [], output_text: 'hi', usage: {} });
    const tools = [{ type: 'function', name: 'count_jobs', parameters: {}, strict: false }];
    const input = [{ role: 'user', content: 'how many jobs' }];
    await step({ client, instructions: 'INSTR', input, tools });

    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0], {
      model: 'test-model-from-config',
      instructions: 'INSTR',
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'low' },
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 6000,
    });
  });

  it('passes toolChoice and maxOutputTokens through', async () => {
    const client = fakeClient({ output: [], output_text: 'x' });
    await step({ client, instructions: 'I', input: [], tools: [], toolChoice: 'none', maxOutputTokens: 123 });
    assert.equal(client.calls[0].tool_choice, 'none');
    assert.equal(client.calls[0].max_output_tokens, 123);
  });

  it('returns text, normalized tool calls, raw output items and usage', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'abc' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'count_jobs', arguments: '{"search":"ml"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'list_jobs', arguments: '{}' },
    ];
    const usage = { input_tokens: 10, output_tokens: 5 };
    const client = fakeClient({ output, output_text: '', usage });
    const res = await step({ client, instructions: 'I', input: [], tools: [] });

    assert.equal(res.text, '');
    assert.deepEqual(res.toolCalls, [
      { callId: 'call_1', name: 'count_jobs', arguments: '{"search":"ml"}' },
      { callId: 'call_2', name: 'list_jobs', arguments: '{}' },
    ]);
    assert.equal(res.outputItems, output);
    assert.deepEqual(res.usage, usage);
  });

  it('treats a missing output_text / output as empty', async () => {
    const client = fakeClient({});
    const res = await step({ client, instructions: 'I', input: [], tools: [] });
    assert.equal(res.text, '');
    assert.deepEqual(res.toolCalls, []);
    assert.deepEqual(res.outputItems, []);
    assert.equal(res.usage, null);
  });

  it('exposes status; a completed response keeps its text', async () => {
    const client = fakeClient({ status: 'completed', output: [], output_text: 'All done.' });
    const res = await step({ client, instructions: 'I', input: [], tools: [] });
    assert.equal(res.status, 'completed');
    assert.equal(res.text, 'All done.');
  });

  it('an incomplete (truncated) response yields empty text so the loop retries or falls back', async () => {
    const client = fakeClient({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      output_text: 'There are 12 jobs and the list is',
    });
    const res = await step({ client, instructions: 'I', input: [], tools: [] });
    assert.equal(res.status, 'incomplete');
    assert.equal(res.text, '');
  });

  it('propagates provider errors to the caller', async () => {
    const client = { responses: { create: async () => { throw new Error('429 rate limited'); } } };
    await assert.rejects(step({ client, instructions: 'I', input: [], tools: [] }), /429/);
  });
});
