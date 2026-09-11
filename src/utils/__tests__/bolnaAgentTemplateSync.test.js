import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureAgentPrompt,
  prepareAgentPromptForCall,
  verifyAgentPromptLive,
} from '../bolnaAgentTemplateSync.js';
import { resetBolnaAgentPromptLocks } from '../bolnaAgentPromptLock.js';
import { resetBolnaAgentRunSerialization } from '../bolnaAgentRunSerialized.js';

/**
 * The bug these cover: Bolna caches the RESOLVED system prompt per agent, keyed on prompt
 * content. A byte-identical template therefore gets a byte-identical cache hit, and the
 * agent keeps reading out whoever it resolved for first — observed live on 2026-09-11,
 * four days stale. The per-call token is what makes the bytes differ.
 */

const TEMPLATE = 'Say: "{q1_line}" then stop.';
const WELCOME = 'Hi, calling about {listing_job_title}.';

/** Stub agent that stores what was PATCHed and serves it back, like Bolna does. */
function fakeBolna({ patchFails = false, goesLiveOnAttempt = 1 } = {}) {
  const state = { stored: null, patches: [], getCalls: 0 };
  return {
    state,
    deps: {
      async updateAgentPrompt(id, prompt, opts) {
        state.patches.push({ id, prompt, welcome: opts?.agentWelcomeMessage });
        if (patchFails) return { success: false, error: 'boom' };
        state.stored = prompt;
        return { success: true };
      },
      async getAgent() {
        state.getCalls += 1;
        if (state.getCalls < goesLiveOnAttempt) {
          // Bolna still serving the previous prompt.
          return { success: true, agent: { agent_config: { system_prompt: 'STALE PROMPT' } } };
        }
        return { success: true, agent: { agent_config: { system_prompt: state.stored } } };
      },
    },
  };
}

test('appends a unique token so two syncs never send identical bytes', async () => {
  const a = fakeBolna();
  const first = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);
  const second = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.renderToken, second.renderToken);
  assert.notEqual(a.state.patches[0].prompt, a.state.patches[1].prompt);
  // The memo this replaced skipped the second PATCH entirely. It must not come back.
  assert.equal(a.state.patches.length, 2);
});

test('keeps the template intact and leaves its placeholders alone', async () => {
  const a = fakeBolna();
  const res = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);

  assert.ok(a.state.patches[0].prompt.startsWith(TEMPLATE));
  assert.ok(a.state.patches[0].prompt.includes('{q1_line}'));
  assert.ok(a.state.patches[0].prompt.includes(res.renderToken));
  assert.equal(a.state.patches[0].welcome, WELCOME);
});

test('polls until the agent serves our own token', async () => {
  const a = fakeBolna({ goesLiveOnAttempt: 3 });
  const res = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);

  assert.equal(res.ok, true);
  assert.equal(a.state.getCalls, 3);
});

test('refuses when the prompt never goes live, so the caller cannot dial', async () => {
  const a = fakeBolna({ goesLiveOnAttempt: 99 });
  const res = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);

  assert.equal(res.ok, false);
  assert.match(res.error, /did not become live/i);
});

test('refuses when the PATCH itself fails', async () => {
  const a = fakeBolna({ patchFails: true });
  const res = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);

  assert.equal(res.ok, false);
  assert.equal(res.error, 'boom');
  assert.equal(a.state.getCalls, 0);
});

test('rejects a missing agentId instead of dialling on an unknown prompt', async () => {
  const a = fakeBolna();
  const res = await ensureAgentPrompt(a.deps, '  ', TEMPLATE, WELCOME);

  assert.equal(res.ok, false);
  assert.equal(a.state.patches.length, 0);
});

test('refuses when deps.getAgent is missing instead of throwing', async () => {
  const res = await ensureAgentPrompt(
    { async updateAgentPrompt() { return { success: true }; } },
    'agent-1',
    TEMPLATE,
    WELCOME
  );

  assert.equal(res.ok, false);
  assert.match(res.error, /getAgent/i);
});

test('refuses when deps.updateAgentPrompt is missing instead of throwing', async () => {
  const res = await ensureAgentPrompt(
    { async getAgent() { return { success: true, agent: {} }; } },
    'agent-1',
    TEMPLATE,
    WELCOME
  );

  assert.equal(res.ok, false);
  assert.match(res.error, /updateAgentPrompt/i);
});

test('verifyAgentPromptLive refuses when the token is no longer on the agent', async () => {
  const a = fakeBolna({ goesLiveOnAttempt: 1 });
  const sync = await ensureAgentPrompt(a.deps, 'agent-1', TEMPLATE, WELCOME);
  a.state.stored = 'SOMEONE ELSE PATCHED OVER US';

  const res = await verifyAgentPromptLive(a.deps, 'agent-1', sync.renderToken);
  assert.equal(res.ok, false);
  assert.match(res.error, /changed before dial/i);
});

test('prepareAgentPromptForCall aborts when the lock cannot be acquired', async () => {
  resetBolnaAgentPromptLocks();
  resetBolnaAgentRunSerialization();

  const { acquireBolnaAgentPromptLock, releaseBolnaAgentPromptLock } = await import(
    '../bolnaAgentPromptLock.js'
  );
  const held = await acquireBolnaAgentPromptLock('agent-1', { leaseMs: 5000 });
  assert.equal(held.acquired, true);

  const a = fakeBolna();
  const res = await prepareAgentPromptForCall(a.deps, 'agent-1', TEMPLATE, WELCOME, {
    maxWaitMs: 50,
    pollMs: 10,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /lock/i);
  await releaseBolnaAgentPromptLock('agent-1', held.holder);
});

test('prepareAgentPromptForCall returns renderToken only after live verification', async () => {
  resetBolnaAgentPromptLocks();
  resetBolnaAgentRunSerialization();

  const a = fakeBolna({ goesLiveOnAttempt: 2 });
  const res = await prepareAgentPromptForCall(a.deps, 'agent-1', TEMPLATE, WELCOME, {
    maxWaitMs: 5000,
    pollMs: 20,
  });

  assert.equal(res.ok, true);
  assert.ok(res.renderToken);
  assert.ok(a.state.getCalls >= 2);
});

test('dialFn runs before the prompt lock is released', async () => {
  resetBolnaAgentPromptLocks();
  resetBolnaAgentRunSerialization();

  const { acquireBolnaAgentPromptLock } = await import('../bolnaAgentPromptLock.js');
  const a = fakeBolna({ goesLiveOnAttempt: 1 });
  let lockHeldDuringDial = false;

  const res = await prepareAgentPromptForCall(
    a.deps,
    'agent-1',
    TEMPLATE,
    WELCOME,
    {},
    async () => {
      const probe = await acquireBolnaAgentPromptLock('agent-1', { maxWaitMs: 30, pollMs: 5 });
      lockHeldDuringDial = !probe.acquired;
      return { success: true, executionId: 'exec-1' };
    }
  );

  assert.equal(res.ok, true);
  assert.equal(lockHeldDuringDial, true);
  assert.deepEqual(res.dialResult, { success: true, executionId: 'exec-1' });
});

test('dialFn is skipped when prompt preparation fails', async () => {
  resetBolnaAgentPromptLocks();
  resetBolnaAgentRunSerialization();

  const a = fakeBolna({ patchFails: true });
  let dialCalled = false;

  const res = await prepareAgentPromptForCall(
    a.deps,
    'agent-1',
    TEMPLATE,
    WELCOME,
    {},
    async () => {
      dialCalled = true;
      return { success: true };
    }
  );

  assert.equal(res.ok, false);
  assert.equal(dialCalled, false);
});

test('dialFn is skipped when keepalive reports lease loss before dial', async () => {
  resetBolnaAgentPromptLocks();
  resetBolnaAgentRunSerialization();

  const a = fakeBolna({ goesLiveOnAttempt: 1 });
  let dialCalled = false;

  const res = await prepareAgentPromptForCall(
    a.deps,
    'agent-1',
    TEMPLATE,
    WELCOME,
    {
      leaseMs: 100,
      keepaliveMs: 5,
      renewFn: async () => false,
    },
    async () => {
      dialCalled = true;
      return { success: true, executionId: 'exec-1' };
    }
  );

  assert.equal(res.ok, false);
  assert.match(res.error, /renew|lease/i);
  assert.equal(dialCalled, false);
});
