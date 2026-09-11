import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureAgentPrompt } from '../bolnaAgentTemplateSync.js';

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
