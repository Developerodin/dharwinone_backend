import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../../../config/config.js';
import { runAgent } from '../runAgent.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

function call(callId, name, args = {}) {
  return { callId, name, arguments: JSON.stringify(args) };
}

function stepResult({ text = '', toolCalls = [], usage = { input_tokens: 10, output_tokens: 2 } } = {}) {
  const outputItems = toolCalls.map((c) => ({
    type: 'function_call',
    call_id: c.callId,
    name: c.name,
    arguments: c.arguments,
  }));
  return { text, toolCalls, outputItems, usage };
}

/** Scripted llm.step: returns responses[i] on the i-th call, records every request. */
function scriptedStep(responses) {
  const requests = [];
  const fn = async (req) => {
    // Snapshot input: the loop may keep appending to its own array.
    requests.push({ ...req, input: req.input.slice() });
    const next = responses[requests.length - 1];
    if (!next) throw new Error(`unexpected step #${requests.length}`);
    if (next instanceof Error) throw next;
    return next;
  };
  fn.requests = requests;
  return fn;
}

function jobFacts(total) {
  return { counts: [{ kind: 'count_jobs', label: 'jobs', total }], primary: null };
}

/**
 * Fake registry. `results` maps tool name → (args) => {ok,result}|{ok:false,error}.
 * count_jobs renders count facts; handoff is the built-in.
 */
function fakeRegistry(results = {}) {
  const executed = [];
  return {
    executed,
    schemas: [{ type: 'function', name: 'count_jobs', parameters: {}, strict: false }],
    instructions: 'JOBS DOMAIN SNIPPET',
    async execute(name, rawArgs, { requestId } = {}) {
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
      executed.push({ name, args, requestId });
      const impl = results[name];
      if (!impl) return { ok: false, error: `Unknown tool '${name}'.` };
      return impl(args);
    },
    render(name, result) {
      if (name === 'count_jobs') {
        return { blocks: [{ type: 'text', id: `b-${result.total}` }], facts: jobFacts(result.total) };
      }
      return null;
    },
    isHandoff: (name) => name === 'handoff',
  };
}

function baseDeps(step, registry) {
  return {
    step,
    getAgentTools: async () => registry,
    resolveViewerRoleNames: async () => ['Administrator'],
    now: () => new Date('2026-09-28T10:00:00Z'),
  };
}

const user = { id: 'u1', name: 'Prakhar' };
const history = [{ role: 'user', content: 'how many ml jobs?' }];
const client = {
  responses: {
    create: async () => {
      throw new Error('live client must not be used');
    },
  },
};

function outputsIn(input) {
  return input.filter((i) => i.type === 'function_call_output');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  let original;
  beforeEach(() => {
    original = { ...config.chatbot.agent };
    config.chatbot.agent.maxSteps = 5;
    config.chatbot.agent.inputBudget = 60000;
  });
  afterEach(() => {
    Object.assign(config.chatbot.agent, original);
  });

  it('tool → answer: executes the call, feeds the output back, applies enforceCounts', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 12 } }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'count_jobs', { search: 'ml' })] }),
      stepResult({ text: 'There are **7** jobs matching ml.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r1', deps: baseDeps(step, registry) });

    assert.ok(out);
    assert.equal(out.reply, 'There are **12** jobs matching ml.');
    assert.deepEqual(out.blocks, [{ type: 'text', id: 'b-12' }]);
    assert.equal(out.meta.steps, 2);
    assert.deepEqual(out.meta.toolCalls, ['count_jobs']);
    assert.equal(typeof out.meta.ms, 'number');
    assert.deepEqual(out.ledgerEntry.calls, [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }]);

    assert.deepEqual(registry.executed, [{ name: 'count_jobs', args: { search: 'ml' }, requestId: 'r1' }]);
    const second = step.requests[1];
    assert.equal(second.tools, registry.schemas);
    assert.equal(second.toolChoice ?? 'auto', 'auto');
    assert.equal(second.client, client);
    const fcIndex = second.input.findIndex((i) => i.type === 'function_call' && i.call_id === 'c1');
    const fcoIndex = second.input.findIndex((i) => i.type === 'function_call_output' && i.call_id === 'c1');
    assert.ok(fcIndex >= 0 && fcoIndex > fcIndex, 'output items then outputs are appended in order');
    assert.deepEqual(JSON.parse(second.input[fcoIndex].output), { total: 12 });
  });

  it('instructions = domain-neutral base + registry instructions; turn context in input', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'Hello.' })]);
    await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    const { instructions, input } = step.requests[0];
    assert.match(instructions, /tool/i);
    assert.ok(instructions.endsWith('\n\nJOBS DOMAIN SNIPPET'));
    assert.equal(input[0].role, 'developer');
    assert.match(input[0].content, /Prakhar/);
    assert.match(input[0].content, /Administrator/);
    assert.match(input[0].content, /2026-09-28/);
    assert.deepEqual(input.at(-1), { role: 'user', content: 'how many ml jobs?' });
  });

  it('handoff → null, without executing sibling calls', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 1 } }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'count_jobs'), call('c2', 'handoff', { reason: 'attendance' })] }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
    assert.equal(registry.executed.length, 0);
  });

  it('step cap → one final tool_choice none step answers', async () => {
    config.chatbot.agent.maxSteps = 3;
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 4 } }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { search: 'x' })] }),
      stepResult({ toolCalls: [call('b', 'count_jobs', { search: 'y' })] }),
      stepResult({ toolCalls: [call('c', 'count_jobs', { search: 'z' })] }),
      stepResult({ text: 'Found 4 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(step.requests.length, 4);
    assert.equal(step.requests[3].toolChoice, 'none');
    for (const r of step.requests.slice(0, 3)) assert.equal(r.toolChoice ?? 'auto', 'auto');
    assert.equal(out.reply, 'Found 4 jobs.');
    assert.equal(out.meta.steps, 4);
    assert.equal(outputsIn(step.requests[3].input).length, 3);
  });

  it('step cap with an empty final answer → null', async () => {
    config.chatbot.agent.maxSteps = 1;
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 4 } }) });
    const step = scriptedStep([stepResult({ toolCalls: [call('a', 'count_jobs')] }), stepResult({ text: '   ' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
  });

  it('empty text → one tool_choice none retry → answer', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: '' }), stepResult({ text: 'Recovered.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(step.requests[1].toolChoice, 'none');
    assert.equal(out.reply, 'Recovered.');
  });

  it('empty text → retry still empty → null', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: '' }), stepResult({ text: '' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(step.requests.length, 2);
    assert.equal(out, null);
  });

  it('thrown error anywhere → null', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([new Error('OpenAI 500')]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);

    const failingDeps = {
      ...baseDeps(scriptedStep([]), registry),
      getAgentTools: async () => {
        throw new Error('boom');
      },
    };
    assert.equal(await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: failingDeps }), null);
  });

  it('more than 8 calls in one step → first 8 executed, the rest answered with an error', async () => {
    const registry = fakeRegistry({ count_jobs: (args) => ({ ok: true, result: { total: args.n } }) });
    const calls = Array.from({ length: 11 }, (_, n) => call(`c${n}`, 'count_jobs', { n }));
    const step = scriptedStep([stepResult({ toolCalls: calls }), stepResult({ text: 'Done.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });

    assert.equal(registry.executed.length, 8);
    assert.deepEqual(
      registry.executed.map((e) => e.args.n),
      [0, 1, 2, 3, 4, 5, 6, 7]
    );
    const outputs = outputsIn(step.requests[1].input);
    assert.deepEqual(outputs.map((o) => o.call_id).sort(), calls.map((c) => c.callId).sort());
    for (const o of outputs.filter((x) => ['c8', 'c9', 'c10'].includes(x.call_id))) {
      assert.deepEqual(JSON.parse(o.output), { error: 'too many calls in one step' });
    }
    assert.equal(out.reply, 'Done.');
    assert.equal(out.ledgerEntry.calls.length, 8);
  });

  it('a failed call returns { error } as its output and the loop continues', async () => {
    let attempts = 0;
    const registry = fakeRegistry({
      count_jobs: () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: '"status" must be one of [Active]' } : { ok: true, result: { total: 3 } };
      },
    });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { status: 'bogus' })] }),
      stepResult({ toolCalls: [call('b', 'count_jobs', { status: 'Active' })] }),
      stepResult({ text: 'There are 3 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.deepEqual(JSON.parse(outputsIn(step.requests[1].input)[0].output), { error: '"status" must be one of [Active]' });
    assert.equal(out.reply, 'There are 3 jobs.');
    assert.deepEqual(out.ledgerEntry.calls, [{ tool: 'count_jobs', args: { status: 'Active' }, total: 3 }]);
  });

  it('same tool failing validation twice in a turn → null', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: false, error: '"status" must be a string' }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { status: 1 })] }),
      stepResult({ toolCalls: [call('b', 'count_jobs', { status: 2 })] }),
      stepResult({ text: 'should not get here' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
    assert.equal(step.requests.length, 2);
  });

  it('follow-up: history + ledger reach the input and the model re-calls the tool', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 5 } }) });
    const memDoc = {
      agentLedger: [{ at: new Date(), calls: [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }] }],
    };
    const followUpHistory = [
      { role: 'user', content: 'how many ml jobs?' },
      { role: 'assistant', content: 'There are 12 ml jobs.' },
      { role: 'user', content: 'what about ai' },
    ];
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'count_jobs', { search: 'ai' })] }),
      stepResult({ text: 'There are 12 jobs for ai.' }),
    ]);
    const out = await runAgent({
      client,
      user,
      history: followUpHistory,
      memDoc,
      requestId: 'r',
      deps: baseDeps(step, registry),
    });

    const firstInput = step.requests[0].input;
    assert.match(firstInput[0].content, /count_jobs\(\{"search":"ml"\}\) → total 12/);
    assert.deepEqual(firstInput.slice(1), followUpHistory);
    assert.deepEqual(registry.executed[0].args, { search: 'ai' });
    // The stale 12 from the previous turn is corrected to this turn's tool total.
    assert.equal(out.reply, 'There are 5 jobs for ai.');
  });

  it('two count calls with different totals for one label → counts not enforced', async () => {
    const totals = { internship: 9, contract: 4 };
    const registry = fakeRegistry({ count_jobs: (args) => ({ ok: true, result: { total: totals[args.jobType] } }) });
    // With only the last call's facts (4), enforceCounts would rewrite "9 jobs" to "4 jobs".
    const text = '9 jobs are internships and 4 jobs are contract.';
    const step = scriptedStep([
      stepResult({
        toolCalls: [call('a', 'count_jobs', { jobType: 'internship' }), call('b', 'count_jobs', { jobType: 'contract' })],
      }),
      stepResult({ text }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out.reply, text);
    // Blocks still come from the last renderable call.
    assert.deepEqual(out.blocks, [{ type: 'text', id: 'b-4' }]);
  });

  it('two count calls agreeing on one total for a label → counts enforced', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 6 } }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { search: 'ml' })] }),
      stepResult({ toolCalls: [call('b', 'count_jobs', { search: 'ml', status: 'Active' })] }),
      stepResult({ text: 'You have 8 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out.reply, 'You have 6 jobs.');
  });

  it('answer without any tool call → reply as-is, no blocks, empty ledger', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'I can help with jobs.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out.reply, 'I can help with jobs.');
    assert.deepEqual(out.blocks, []);
    assert.deepEqual(out.ledgerEntry.calls, []);
  });
});
