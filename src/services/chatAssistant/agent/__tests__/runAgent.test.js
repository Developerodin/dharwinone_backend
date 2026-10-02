import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import config from '../../../../config/config.js';
import { runAgent } from '../runAgent.js';
import { speechBasis } from '../../quoteGrounding.js';
import { defineTool } from '../defineTool.js';
import { getAgentTools } from '../toolRegistry.js';

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
    config.chatbot.agent.stepTimeoutMs = 20000;
    config.chatbot.agent.turnTimeoutMs = 30000;
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

  it('keeps task cards and drops a second markdown table of the same rows', async () => {
    const registry = fakeRegistry({
      list_tasks: () => ({ ok: true, result: { total: 2 } }),
    });
    const block = {
      type: 'table',
      tableType: 'task-list',
      title: 'Tasks (2)',
      rows: [{ title: 'Alpha setup', status: 'new' }, { title: 'Beta review', status: 'todo' }],
    };
    registry.render = () => ({ blocks: [block], facts: { counts: [], primary: null } });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'list_tasks', {})] }),
      stepResult({
        text: [
          'There are 2 open tasks.',
          '',
          '| Task | Status |',
          '| --- | --- |',
          '| Alpha setup | new |',
          '| Beta review | todo |',
        ].join('\n'),
      }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r-tasks', deps: baseDeps(step, registry) });
    assert.equal(out.reply, 'There are 2 open tasks.');
    assert.equal(out.blocks[0], block);
  });

  it('strips a follow-up quote that is not in the loaded transcript', async () => {
    const registry = fakeRegistry({
      get_call_takeaways: () => ({
        ok: true,
        result: {
          transcriptAvailable: true,
          transcript: 'user: I can join on 1 November.',
          takeaways: { joiningDate: null },
        },
      }),
    });
    registry.render = () => null;
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'get_call_takeaways', { call: 'exec-1' })] }),
      stepResult({ text: 'The candidate said "I want forty lakhs".' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r-quote', deps: baseDeps(step, registry) });
    assert.ok(out);
    assert.equal(out.reply.includes('forty lakhs'), false);
    assert.equal(out.reply.includes('did not capture'), false);
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

  it('onOutcome names why a turn was not answered (the caller picks the fixed reply from it)', async () => {
    const outcomeOf = async (responses, results = {}) => {
      const seen = [];
      const step = scriptedStep(responses);
      await runAgent({ client, user, history, memDoc: null, requestId: 'r', onOutcome: (o) => seen.push(o), deps: baseDeps(step, fakeRegistry(results)) });
      return seen;
    };
    assert.deepEqual(await outcomeOf([stepResult({ toolCalls: [call('h', 'handoff', { reason: 'x' })] })]), ['handoff']);
    assert.deepEqual(await outcomeOf([stepResult({ text: 'Our notice period is 30 days.' })]), ['untooled_number']);
    assert.deepEqual(await outcomeOf([new Error('OpenAI 500')]), ['error']);
    assert.deepEqual(await outcomeOf([stepResult({ text: 'Hi! How can I help?' })]), ['answer']);
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

  it('a later count call with empty blocks keeps the earlier list block', async () => {
    const registry = fakeRegistry({
      list_jobs: () => ({ ok: true, result: { total: 3, jobs: [{}, {}, {}] } }),
      count_jobs: () => ({ ok: true, result: { total: 3 } }),
    });
    registry.render = (name, result) => {
      if (name === 'list_jobs') return { blocks: [{ type: 'list', id: 'job-list' }], facts: jobFacts(result.total) };
      if (name === 'count_jobs') return { blocks: [], facts: jobFacts(result.total) };
      return null;
    };
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'list_jobs', { search: 'ml' }), call('b', 'count_jobs', { search: 'ml' })] }),
      stepResult({ text: 'There are 3 ML jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.deepEqual(out.blocks, [{ type: 'list', id: 'job-list' }]);
  });

  it('a write draft\'s confirm block survives a later list render and is appended after it', async () => {
    const registry = fakeRegistry({
      close_jobs: () => ({ ok: true, result: { draft: true, key: 'k1' } }),
      list_jobs: () => ({ ok: true, result: { total: 2, jobs: [{}, {}] } }),
    });
    registry.render = (name) => {
      if (name === 'close_jobs') return { blocks: [{ type: 'confirm', key: 'k1' }] };
      if (name === 'list_jobs') return { blocks: [{ type: 'list', id: 'job-list' }] };
      return null;
    };
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'close_jobs', {}), call('b', 'list_jobs', {})] }),
      stepResult({ text: 'I drafted closing those jobs. Press Confirm to close them.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.deepEqual(out.blocks, [{ type: 'list', id: 'job-list' }, { type: 'confirm', key: 'k1' }]);
  });

  it('an identical repeat of a draft call in one turn reuses the draft: one stored draft, one confirm card', async () => {
    let drafted = 0;
    const registry = fakeRegistry({
      schedule_interview: () => {
        drafted += 1;
        return { ok: true, result: { draft: true, key: `k${drafted}` } };
      },
    });
    registry.render = (name, result) => (name === 'schedule_interview' ? { blocks: [{ type: 'confirm', key: result.key }] } : null);
    const args = { application: 'a1', scheduledAt: '2026-10-05T11:00:00+05:30', durationMinutes: 45 };
    // Same step (parallel) and a later step, with keys in a different order.
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'schedule_interview', args), call('b', 'schedule_interview', args)] }),
      stepResult({ toolCalls: [call('c', 'schedule_interview', { durationMinutes: 45, scheduledAt: args.scheduledAt, application: 'a1' })] }),
      stepResult({ text: 'Drafted. Press Confirm to schedule it.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(drafted, 1);
    assert.deepEqual(out.blocks, [{ type: 'confirm', key: 'k1' }]);
  });

  it('a repeated read call still runs again (only drafts are reused)', async () => {
    let reads = 0;
    const registry = fakeRegistry({
      count_jobs: () => {
        reads += 1;
        return { ok: true, result: { total: reads } };
      },
    });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { search: 'ml' }), call('b', 'count_jobs', { search: 'ml' })] }),
      stepResult({ text: 'There are 2 ML jobs.' }),
    ]);
    await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(reads, 2);
  });

  it('empty-text retry does not replay that response\'s output items', async () => {
    const registry = fakeRegistry();
    const emptyWithReasoning = { ...stepResult({ text: '' }), outputItems: [{ type: 'reasoning', id: 'rs_lone' }] };
    const step = scriptedStep([emptyWithReasoning, stepResult({ text: 'Recovered.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(step.requests[1].toolChoice, 'none');
    assert.ok(!step.requests[1].input.some((i) => i.type === 'reasoning'));
    assert.deepEqual(step.requests[1].input, step.requests[0].input);
    assert.equal(out.reply, 'Recovered.');
  });

  it('an execute that rejects becomes an { error } output; sibling calls are unaffected', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: true, result: { total: 2 } }) });
    const baseExecute = registry.execute;
    registry.execute = async (name, rawArgs, opts) => {
      if (name === 'list_jobs') throw new Error('registry exploded');
      return baseExecute(name, rawArgs, opts);
    };
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'list_jobs'), call('b', 'count_jobs')] }),
      stepResult({ text: 'There are 2 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    const outputs = outputsIn(step.requests[1].input);
    assert.deepEqual(JSON.parse(outputs.find((o) => o.call_id === 'a').output), { error: 'registry exploded' });
    assert.deepEqual(JSON.parse(outputs.find((o) => o.call_id === 'b').output), { total: 2 });
    assert.equal(out.reply, 'There are 2 jobs.');
    assert.deepEqual(out.ledgerEntry.calls, [{ tool: 'count_jobs', args: {}, total: 2 }]);
  });

  it('two failures of one tool in the SAME step count once: the model sees the errors and recovers', async () => {
    let n = 0;
    const registry = fakeRegistry({
      count_jobs: () => {
        n += 1;
        return n <= 2 ? { ok: false, error: 'bad args' } : { ok: true, result: { total: 7 } };
      },
    });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { x: 1 }), call('b', 'count_jobs', { x: 2 })] }),
      stepResult({ toolCalls: [call('c', 'count_jobs', { search: 'ml' })] }),
      stepResult({ text: 'There are 7 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.ok(out);
    assert.equal(out.reply, 'There are 7 jobs.');
  });

  it('same-step double failure, then the same tool fails again in a later step → null', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: false, error: 'bad args' }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { x: 1 }), call('b', 'count_jobs', { x: 2 })] }),
      stepResult({ toolCalls: [call('c', 'count_jobs', { x: 3 })] }),
      stepResult({ text: 'should not get here' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
    assert.equal(step.requests.length, 2);
  });

  it('answer without any tool call → reply as-is, no blocks, empty ledger', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'I can help with jobs.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out.reply, 'I can help with jobs.');
    assert.deepEqual(out.blocks, []);
    assert.deepEqual(out.ledgerEntry.calls, []);
  });

  it('a number with no tool call this turn -> null (nothing to check it against)', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'Our notice period is 30 days.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
  });

  it('a number after only failed tool calls -> null', async () => {
    const registry = fakeRegistry({ count_jobs: () => ({ ok: false, error: 'bad filter' }) });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'count_jobs', { search: 'x' })] }),
      stepResult({ text: 'There are 5 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
  });

  it('base instructions send company-specific questions to a tool or handoff; definitions still answer', async () => {
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'MERN is MongoDB, Express, React and Node.' })]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out.reply, 'MERN is MongoDB, Express, React and Node.');
    assert.match(step.requests[0].instructions, /THIS company.*`handoff`/);
  });

  it('each step gets the step timeout, capped to the time left in the turn', async () => {
    config.chatbot.agent.stepTimeoutMs = 20000;
    config.chatbot.agent.turnTimeoutMs = 5000;
    const registry = fakeRegistry();
    const step = scriptedStep([stepResult({ text: 'Hello.' })]);
    await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    const t = step.requests[0].timeoutMs;
    assert.ok(t > 0 && t <= 5000, `timeoutMs ${t}`);
  });

  it('turn deadline passed -> null without another model step', async () => {
    config.chatbot.agent.turnTimeoutMs = 30;
    const registry = fakeRegistry({
      count_jobs: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, result: { total: 3 } };
      },
    });
    const step = scriptedStep([
      stepResult({ toolCalls: [call('c1', 'count_jobs')] }),
      stepResult({ text: 'There are 3 jobs.' }),
    ]);
    const out = await runAgent({ client, user, history, memDoc: null, requestId: 'r', deps: baseDeps(step, registry) });
    assert.equal(out, null);
    assert.equal(step.requests.length, 1);
  });
});

// ─── Lazy tool loading (real registry over fake domains) ────────────────────

const lazyJobs = {
  domain: 'jobs',
  summary: 'Job postings.',
  instructions: 'JOBS INSTRUCTIONS',
  tools: [
    defineTool({
      name: 'count_jobs',
      domain: 'jobs',
      kind: 'read',
      description: 'Count jobs.',
      input: Joi.object({ search: Joi.string() }),
      access: { anyOf: ['jobs.read'] },
      execute: async () => ({ total: 12 }),
      render: (result) => ({ blocks: [{ type: 'text', id: `b-${result.total}` }], facts: jobFacts(result.total) }),
    }),
  ],
};
const lazyLeave = {
  domain: 'leave',
  summary: 'Who is on leave.',
  instructions: 'LEAVE INSTRUCTIONS',
  tools: [
    defineTool({
      name: 'who_is_on_leave_today',
      domain: 'leave',
      kind: 'read',
      description: 'Who is on leave today.',
      input: Joi.object({}),
      access: { anyOf: ['leave.read'] },
      execute: async () => ({ total: 1, records: [{ name: 'Asha' }] }),
    }),
  ],
};
const lazyTasks = {
  domain: 'tasks',
  summary: 'Tasks.',
  instructions: 'TASKS INSTRUCTIONS',
  tools: [
    defineTool({
      name: 'list_tasks',
      domain: 'tasks',
      kind: 'read',
      description: 'List tasks.',
      input: Joi.object({}),
      access: { anyOf: ['tasks.read'] },
      execute: async () => ({ total: 2, records: [] }),
    }),
  ],
};
const LAZY_DOMAINS = [lazyJobs, lazyLeave, lazyTasks];
const superUser = { id: 'u1', name: 'Prakhar', platformSuperUser: true };

function lazyDeps(step, { domains = LAZY_DOMAINS } = {}) {
  return {
    ...baseDeps(step, null),
    getAgentTools: (u) => getAgentTools(u, { domains, eagerLimit: 0 }),
  };
}

const names = (req) => req.tools.map((t) => t.name);

describe('runAgent — lazy tool loading', () => {
  let original;
  beforeEach(() => {
    original = { ...config.chatbot.agent };
    config.chatbot.agent.maxSteps = 5;
    config.chatbot.agent.inputBudget = 60000;
    config.chatbot.agent.stepTimeoutMs = 20000;
    config.chatbot.agent.turnTimeoutMs = 30000;
  });
  afterEach(() => {
    Object.assign(config.chatbot.agent, original);
  });

  it('find_tools step → the next step is offered the loaded schemas; the call is answered with loaded + instructions', async () => {
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['leave', 'tasks'] })] }),
      stepResult({ toolCalls: [call('a', 'who_is_on_leave_today'), call('b', 'list_tasks')] }),
      stepResult({ text: 'Asha is on leave and has tasks due.' }),
    ]);
    const out = await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });

    assert.deepEqual(names(step.requests[0]), ['find_tools', 'handoff']);
    assert.match(step.requests[0].instructions, /call `find_tools`/);
    assert.doesNotMatch(step.requests[0].instructions, /LEAVE INSTRUCTIONS/);
    assert.deepEqual(names(step.requests[1]), ['find_tools', 'handoff', 'list_tasks', 'who_is_on_leave_today']);
    assert.equal(step.requests[1].instructions, step.requests[0].instructions);
    const findOutput = outputsIn(step.requests[1].input).find((o) => o.call_id === 'f1');
    assert.deepEqual(JSON.parse(findOutput.output), {
      loaded: ['leave', 'tasks'],
      instructions: 'LEAVE INSTRUCTIONS\n\nTASKS INSTRUCTIONS',
    });
    assert.equal(out.reply, 'Asha is on leave and has tasks due.');
  });

  it('find_tools is kept in meta.toolCalls but left out of the ledger, render and facts', async () => {
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] })] }),
      stepResult({ toolCalls: [call('a', 'count_jobs', { search: 'ml' })] }),
      stepResult({ text: 'There are 7 jobs matching ml.' }),
    ]);
    const out = await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });
    assert.deepEqual(out.meta.toolCalls, ['find_tools', 'count_jobs']);
    assert.deepEqual(out.ledgerEntry.calls, [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }]);
    assert.deepEqual(out.blocks, [{ type: 'text', id: 'b-12' }]);
    assert.equal(out.reply, 'There are 12 jobs matching ml.');
  });

  it('a find_tools-only step is free once per turn', async () => {
    config.chatbot.agent.maxSteps = 1;
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] })] }),
      stepResult({ toolCalls: [call('a', 'count_jobs')] }),
      stepResult({ text: 'There are 12 jobs.' }),
    ]);
    const out = await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });
    assert.equal(step.requests[1].toolChoice ?? 'auto', 'auto');
    assert.equal(step.requests[2].toolChoice, 'none');
    assert.equal(out.reply, 'There are 12 jobs.');
  });

  it('a second find_tools-only step is not free', async () => {
    config.chatbot.agent.maxSteps = 1;
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] })] }),
      stepResult({ toolCalls: [call('f2', 'find_tools', { domains: ['leave'] })] }),
      stepResult({ text: 'I could not find that.' }),
    ]);
    await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });
    assert.equal(step.requests.length, 3);
    assert.equal(step.requests[2].toolChoice, 'none');
  });

  it('a step mixing find_tools with another call is not free', async () => {
    config.chatbot.agent.maxSteps = 1;
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] }), call('x', 'count_jobs')] }),
      stepResult({ text: 'There are 12 jobs.' }),
    ]);
    await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });
    assert.equal(step.requests[1].toolChoice, 'none');
  });

  it('a number after only find_tools → untooled_number', async () => {
    const seen = [];
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] })] }),
      stepResult({ text: 'There are 40 jobs.' }),
    ]);
    const out = await runAgent({
      client, user: superUser, history, memDoc: null, requestId: 'r', onOutcome: (o) => seen.push(o), deps: lazyDeps(step),
    });
    assert.equal(out, null);
    assert.deepEqual(seen, ['untooled_number']);
  });

  it('bad find_tools args → { error } output; failing twice ends the turn', async () => {
    const seen = [];
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['payroll'] })] }),
      stepResult({ toolCalls: [call('f2', 'find_tools', { domains: [] })] }),
      stepResult({ text: 'should not get here' }),
    ]);
    const out = await runAgent({
      client, user: superUser, history, memDoc: null, requestId: 'r', onOutcome: (o) => seen.push(o), deps: lazyDeps(step),
    });
    const first = JSON.parse(outputsIn(step.requests[1].input).find((o) => o.call_id === 'f1').output);
    assert.match(first.error, /must be one of/);
    assert.deepEqual(names(step.requests[1]), ['find_tools', 'handoff']);
    assert.equal(out, null);
    assert.deepEqual(seen, ['repeated_tool_failure']);
  });

  it('never loads a domain the user has no tool in', async () => {
    const leaveOnly = { id: 'u2', name: 'Asha', authContext: { permissions: new Set(['leave.read']) } };
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs'] })] }),
      stepResult({ text: 'I cannot see jobs.' }),
    ]);
    await runAgent({ client, user: leaveOnly, history, memDoc: null, requestId: 'r', deps: lazyDeps(step) });
    assert.deepEqual(names(step.requests[1]), ['find_tools', 'handoff']);
    const find = step.requests[0].tools.find((t) => t.name === 'find_tools');
    assert.deepEqual(find.parameters.properties.domains.items.enum, ['leave']);
  });

  it('ledger preload: the last entry\'s domains are loaded before step 1, instructions as one input item', async () => {
    const memDoc = {
      agentLedger: [
        { at: new Date(), calls: [{ tool: 'list_tasks', args: {}, total: 2 }] },
        { at: new Date(), calls: [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }] },
      ],
    };
    const followUp = [
      { role: 'user', content: 'how many ml jobs?' },
      { role: 'assistant', content: 'There are 12 ml jobs.' },
      { role: 'user', content: 'what about ai' },
    ];
    const step = scriptedStep([
      stepResult({ toolCalls: [call('a', 'count_jobs', { search: 'ai' })] }),
      stepResult({ text: 'There are 5 jobs for ai.' }),
    ]);
    const out = await runAgent({ client, user: superUser, history: followUp, memDoc, requestId: 'r', deps: lazyDeps(step) });

    const first = step.requests[0];
    assert.deepEqual(names(first), ['count_jobs', 'find_tools', 'handoff']);
    assert.doesNotMatch(first.instructions, /JOBS INSTRUCTIONS/);
    assert.equal(first.input[0].role, 'developer');
    assert.deepEqual(first.input[1], { role: 'developer', content: 'Tools already loaded for: jobs.\n\nJOBS INSTRUCTIONS' });
    assert.deepEqual(first.input.slice(2), followUp);
    assert.equal(out.reply, 'There are 12 jobs for ai.');
  });

  it('ledger preload ignores malformed entries, removed tools and domains the user lost', async () => {
    const leaveOnly = { id: 'u2', name: 'Asha', authContext: { permissions: new Set(['leave.read']) } };
    const ledgers = [
      { agentLedger: { not: 'an array' } },
      { agentLedger: [null] },
      { agentLedger: [{ at: new Date(), calls: 'garbage' }] },
      { agentLedger: [{ at: new Date(), calls: [null, { tool: 'removed_tool' }, { tool: 42 }] }] },
      // jobs is a real domain, but this user has no jobs tool any more.
      { agentLedger: [{ at: new Date(), calls: [{ tool: 'count_jobs', args: {}, total: 12 }] }] },
    ];
    for (const memDoc of ledgers) {
      const step = scriptedStep([stepResult({ text: 'Hello.' })]);
      // eslint-disable-next-line no-await-in-loop
      const out = await runAgent({ client, user: leaveOnly, history, memDoc, requestId: 'r', deps: lazyDeps(step) });
      assert.equal(out?.reply, 'Hello.', JSON.stringify(memDoc));
      assert.deepEqual(names(step.requests[0]), ['find_tools', 'handoff']);
      assert.equal(step.requests[0].input.filter((i) => i.role === 'developer').length, 1);
    }
  });

  it('find_tools output (loaded instructions) survives compaction; other outputs are compacted', async () => {
    config.chatbot.agent.inputBudget = 500;
    const bigDomains = [
      { ...lazyJobs, instructions: 'JOBS INSTRUCTIONS '.repeat(20) },
      lazyLeave,
      {
        ...lazyTasks,
        tools: [
          defineTool({
            name: 'list_tasks',
            domain: 'tasks',
            kind: 'read',
            description: 'List tasks.',
            input: Joi.object({}),
            access: { anyOf: ['tasks.read'] },
            execute: async () => ({ total: 2, records: Array.from({ length: 50 }, (_, i) => ({ title: `Task ${i}` })) }),
          }),
        ],
      },
    ];
    const step = scriptedStep([
      stepResult({ toolCalls: [call('f1', 'find_tools', { domains: ['jobs', 'tasks'] })] }),
      stepResult({ toolCalls: [call('a', 'list_tasks')] }),
      stepResult({ toolCalls: [call('b', 'list_tasks')] }),
      stepResult({ text: 'Done.' }),
    ]);
    await runAgent({ client, user: superUser, history, memDoc: null, requestId: 'r', deps: lazyDeps(step, { domains: bigDomains }) });
    const outputs = outputsIn(step.requests[3].input);
    assert.match(outputs.find((o) => o.call_id === 'f1').output, /JOBS INSTRUCTIONS/);
    assert.equal(JSON.parse(outputs.find((o) => o.call_id === 'a').output).compacted, true);
  });

  it('eager registry: no preload item even with a ledger', async () => {
    const memDoc = { agentLedger: [{ at: new Date(), calls: [{ tool: 'count_jobs', args: {}, total: 12 }] }] };
    const step = scriptedStep([stepResult({ text: 'Hello.' })]);
    const deps = { ...lazyDeps(step), getAgentTools: (u) => getAgentTools(u, { domains: LAZY_DOMAINS }) };
    await runAgent({ client, user: superUser, history, memDoc, requestId: 'r', deps });
    const first = step.requests[0];
    assert.deepEqual(names(first), ['count_jobs', 'handoff', 'list_tasks', 'who_is_on_leave_today']);
    assert.match(first.instructions, /JOBS INSTRUCTIONS\n\nLEAVE INSTRUCTIONS\n\nTASKS INSTRUCTIONS$/);
    assert.equal(first.input.filter((i) => i.role === 'developer').length, 1);
  });
});

describe('transcript follow-up grounding', () => {
  let original;
  beforeEach(() => {
    original = { ...config.chatbot.agent };
    config.chatbot.agent.maxSteps = 5;
    config.chatbot.agent.inputBudget = 60000;
    config.chatbot.agent.stepTimeoutMs = 20000;
    config.chatbot.agent.turnTimeoutMs = 30000;
  });
  afterEach(() => {
    Object.assign(config.chatbot.agent, original);
  });

  const TRANSCRIPT = [
    '[00:40] agent: What salary are you expecting?',
    '[01:05] user: I can join on 1 November.',
  ].join('\n');

  function callsRegistry() {
    const registry = fakeRegistry({
      get_call_takeaways: () => ({
        ok: true,
        result: {
          call: { id: 'exec-1' },
          transcriptAvailable: true,
          transcript: TRANSCRIPT,
          takeaways: { joiningDate: null },
        },
      }),
    });
    registry.render = () => null;
    return registry;
  }

  async function ask({ history, memDoc, text, toolCalls, transcript = TRANSCRIPT, available = true }) {
    const loads = [];
    const registry = callsRegistry();
    const step = scriptedStep([
      toolCalls
        ? stepResult({ toolCalls })
        : null,
      stepResult({ text }),
    ].filter(Boolean));
    const out = await runAgent({
      client,
      user,
      history,
      memDoc,
      requestId: 'r-transcript',
      deps: {
        ...baseDeps(step, registry),
        loadCallTranscript: async (id) => {
          loads.push(id);
          return available
            ? { transcriptAvailable: true, transcript }
            : { transcriptAvailable: false, transcript: '' };
        },
      },
    });
    return { out, loads, registry };
  }

  it('loads the transcript, answers, and records the call id without the transcript body', async () => {
    const history = [{ role: 'user', content: 'What did he say about joining?' }];
    const { out, loads } = await ask({
      history,
      memDoc: null,
      toolCalls: [call('c1', 'get_call_takeaways', { call: 'exec-1' })],
      text: 'The candidate said "I can join on 1 November."',
    });
    assert.match(out.reply, /I can join on 1 November/);
    assert.equal(out.ledgerEntry.calls[0].callId, 'exec-1');
    assert.equal(out.ledgerEntry.calls[0].transcriptLoaded, true);
    assert.equal(JSON.stringify(out.ledgerEntry).includes('What salary'), false);
    assert.deepEqual(loads, []);
    return out.ledgerEntry;
  });

  async function opened() {
    const first = await ask({
      history: [{ role: 'user', content: 'What did he say about joining?' }],
      memDoc: null,
      toolCalls: [call('c1', 'get_call_takeaways', { call: 'exec-1' })],
      text: 'The candidate said "I can join on 1 November."',
    });
    return {
      memDoc: { agentLedger: [first.out.ledgerEntry] },
      priorReply: first.out.reply,
    };
  }

  it('keeps an exact follow-up quote without the user pasting the transcript or another tool call', async () => {
    const { memDoc } = await opened();
    const history = [
      { role: 'user', content: 'What did he say about joining?' },
      { role: 'assistant', content: 'The candidate said "I can join on 1 November."' },
      { role: 'user', content: 'What exactly did he say?' },
    ];
    const { out, loads, registry } = await ask({
      history,
      memDoc,
      text: 'The candidate said "I can join on 1 November."',
    });
    assert.deepEqual(loads, ['exec-1']);
    assert.equal(registry.executed.length, 0);
    assert.equal(history.some((m) => m.role === 'user' && m.content.includes('What salary')), false);
    assert.match(out.reply, /I can join on 1 November/);
    assert.equal(speechBasis({
      transcriptAvailable: true, transcript: TRANSCRIPT, claim: 'I can join on 1 November',
    }), 'explicit');
  });

  it('does not agree with a user quote the transcript does not contain', async () => {
    const { memDoc } = await opened();
    const history = [
      { role: 'user', content: 'What did he say about joining?' },
      { role: 'assistant', content: 'The candidate said "I can join on 1 November."' },
      { role: 'user', content: 'I think he said he could join immediately' },
    ];
    const { out, loads } = await ask({
      history,
      memDoc,
      text: 'Yes, he said he could join immediately.',
    });
    assert.deepEqual(loads, ['exec-1']);
    assert.equal(out.reply.includes('immediately'), false);
    assert.equal(out.reply.includes('Yes'), false);
  });

  it('keeps the exact sentence when it is in the reloaded transcript', async () => {
    const { memDoc } = await opened();
    const { out } = await ask({
      history: [{ role: 'user', content: 'Give me the exact sentence.' }],
      memDoc,
      text: 'The candidate said "I can join on 1 November."',
    });
    assert.match(out.reply, /"I can join on 1 November."/);
  });

  it('marks a Monday join as absent and drops the invented quote', async () => {
    const { memDoc } = await opened();
    const claim = 'I can join on Monday';
    assert.equal(speechBasis({ transcriptAvailable: true, transcript: TRANSCRIPT, claim }), 'absent');
    const { out } = await ask({
      history: [{ role: 'user', content: 'Did he say he could join on Monday?' }],
      memDoc,
      text: 'The candidate said "I can join on Monday."',
    });
    assert.equal(out.reply.includes('"I can join on Monday."'), false);
    assert.equal(out.reply.includes('did not capture'), false);
    assert.equal(out.reply.includes("didn't capture"), false);
  });

  it('does not present an inferred sentence as an exact quote', async () => {
    const { memDoc } = await opened();
    const claim = 'I can join on 1 November next year';
    assert.equal(speechBasis({ transcriptAvailable: true, transcript: TRANSCRIPT, claim }), 'inferred');
    const { out } = await ask({
      history: [{ role: 'user', content: 'Give me the exact sentence about joining.' }],
      memDoc,
      text: `The candidate said "${claim}."`,
    });
    assert.equal(out.reply.includes('next year'), false);
    assert.equal(out.reply.includes(`"${claim}"`), false);
  });

  it('does not say the transcript failed to capture something when none is available', async () => {
    const { memDoc } = await opened();
    const { out } = await ask({
      history: [{ role: 'user', content: 'What exactly did he say?' }],
      memDoc,
      available: false,
      text: 'The transcript did not capture a joining date. The candidate said "I can join on 1 November."',
    });
    assert.equal(out.reply.includes('did not capture'), false);
    assert.equal(out.reply.includes('I can join on 1 November'), false);
    assert.match(out.reply, /No transcript is available/);
    assert.equal(speechBasis({ transcriptAvailable: false, transcript: '', claim: 'I can join on 1 November' }), 'no_transcript');
  });

  it('follows the reloaded transcript when the previous assistant line was wrong', async () => {
    const { memDoc } = await opened();
    const history = [
      { role: 'user', content: 'Did he mention joining?' },
      { role: 'assistant', content: 'He did not mention joining.' },
      { role: 'user', content: 'That is wrong. What did he say?' },
    ];
    const { out, loads } = await ask({
      history,
      memDoc,
      text: 'He did not mention joining.',
    });
    assert.deepEqual(loads, ['exec-1']);
    assert.match(out.reply, /I can join on 1 November/);
    assert.equal(out.reply.includes('did not mention'), false);
    assert.equal(history[1].content.includes('I can join on 1 November'), false);
  });

  it('does not reload a transcript for a question that is not about what was said', async () => {
    const { memDoc } = await opened();
    const { out, loads } = await ask({
      history: [{ role: 'user', content: 'Thanks, that helps.' }],
      memDoc,
      text: 'Glad to help.',
    });
    assert.deepEqual(loads, []);
    assert.equal(out.reply, 'Glad to help.');
  });

  const TRANSCRIPT_QUESTIONS = [
    'What was his joining date?',
    'Did he mention when he could join?',
    'What did he say about joining?',
    'Was immediate joining discussed?',
    'Did he agree to Monday?',
    'Can you show me his exact words about availability?',
    'What did the candidate say regarding relocation?',
    'Was relocation discussed?',
  ];

  for (const question of TRANSCRIPT_QUESTIONS) {
    it(`reloads the prior call before grounding: ${question}`, async () => {
      const { memDoc } = await opened();
      const { loads } = await ask({
        history: [{ role: 'user', content: question }],
        memDoc,
        text: 'Checking the call.',
      });
      assert.deepEqual(loads, ['exec-1']);
    });
  }

  it('does not reload the prior call when the question lists employees', async () => {
    const { memDoc } = await opened();
    const { out, loads } = await ask({
      history: [{ role: 'user', content: 'List employees' }],
      memDoc,
      text: 'He said the roster is ready.',
    });
    assert.deepEqual(loads, []);
    assert.equal(out.reply, 'He said the roster is ready.');
  });
});
