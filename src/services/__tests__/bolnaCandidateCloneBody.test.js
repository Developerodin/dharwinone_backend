import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCandidateToolsPutBody } from '../bolnaCandidateToolsSetup.service.js';

function sampleAgent() {
  return {
    agent_name: 'Candidate Template',
    agent_welcome_message: 'Hello from template',
    webhook_url: 'https://example.com/webhook',
    agent_type: 'other',
    tasks: [
      {
        task_type: 'conversation',
        tools_config: {
          llm_agent: { family: 'openai' },
          input: { provider: 'twilio' },
          output: { provider: 'twilio' },
          synthesizer: { provider: 'elevenlabs', provider_config: { voice_id: 'abc' } },
          api_tools: {
            tools: [{ name: 'existing_tool', key: 'custom_task' }],
            tools_params: { existing_tool: { method: 'GET', url: 'https://example.com/existing' } },
          },
        },
      },
    ],
    agent_prompts: {
      task_1: {
        system_prompt: 'Original prompt',
      },
    },
  };
}

test('buildCandidateToolsPutBody applies per-call overrides without mutating source agent', () => {
  const source = sampleAgent();
  const originalJson = JSON.stringify(source);

  const out = buildCandidateToolsPutBody(source, null, {
    systemPrompt: 'Per-call prompt text',
    agentWelcomeMessage: 'Per-call welcome',
    agentName: 'candidate-verification-clone',
  });

  assert.equal(out.agent_config.agent_name, 'candidate-verification-clone');
  assert.equal(out.agent_config.agent_welcome_message, 'Per-call welcome');
  assert.equal(out.agent_prompts.task_1.system_prompt, 'Per-call prompt text');
  assert.equal(out.agent_config.tasks[0].tools_config.api_tools.tools[0].name, 'existing_tool');
  assert.equal(JSON.stringify(source), originalJson);
});
