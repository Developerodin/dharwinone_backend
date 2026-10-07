import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const TEMPLATE = 'cand-template';

mock.module('../../config/config.js', {
  defaultExport: {
    bolna: {
      apiKey: 'k',
      apiBase: 'https://api.bolna.test',
      toolToken: 'secret-token',
      candidateAgentId: TEMPLATE,
      agentId: 'job-agent',
      allAgentIds: [TEMPLATE, 'job-agent'],
      executionContext: '',
    },
    backendPublicUrl: 'https://backend.example',
    telephony: {},
  },
});

mock.module('../bolnaCandidateAgentSettings.service.js', {
  namedExports: {
    getBolnaCandidateAgentSettingsForPrompt: async () => ({
      extraSystemInstructions: '',
      greetingOverride: '',
    }),
  },
});

mock.module('../kbQuery.service.js', {
  namedExports: { getKbPromptContextForExternalAgent: async () => '' },
});

mock.module('../../models/job.model.js', {
  defaultExport: {
    findById() {
      return { select: () => ({ lean: async () => null }) };
    },
  },
});

mock.module('../../models/interviewerAvailability.model.js', {
  defaultExport: { exists: async () => ({ _id: 'avail' }) },
});

mock.module('../interviewSlot.service.js', {
  namedExports: {
    APPLICATION_REF_TTL_MS: 2 * 60 * 60 * 1000,
    signApplicationRef: (id) => `${id}.sig`,
    buildSlotOffer: async () => {
      throw new Error('buildSlotOffer must not run when tools fail closed');
    },
  },
});

function hostableAgent() {
  return {
    agent_name: 'Candidate_Verification_Staging',
    agent_welcome_message: 'Hello',
    agent_type: 'other',
    agent_prompts: { task_1: { system_prompt: 'sys' } },
    tasks: [
      {
        task_type: 'conversation',
        tools_config: {
          llm_agent: { provider: 'openai' },
          synthesizer: { provider: 'elevenlabs', voice_id: 'voice-1' },
          transcriber: { provider: 'deepgram', language: 'en' },
          input: { provider: 'plivo', format: 'wav' },
          output: { provider: 'plivo', format: 'wav' },
          api_tools: { tools: [{ name: 'other_tool' }] },
        },
      },
    ],
  };
}

mock.module('../bolna.service.js', {
  defaultExport: {
    async getAgent(id) {
      if (id !== TEMPLATE) return { success: false, error: 'unknown' };
      return { success: true, agent: hostableAgent() };
    },
    async putAgent() {
      return { success: true };
    },
    async createAgent() {
      throw new Error('createAgent must not run when tools are missing');
    },
    async initiateCall() {
      throw new Error('initiateCall must not run when tools are missing');
    },
  },
});

let initiateCandidateVerificationCall;

test.before(async () => {
  ({ initiateCandidateVerificationCall } = await import('../bolnaCandidateVerification.service.js'));
});

test('scheduling-enabled call fails closed when interview tools are not verified', async () => {
  const result = await initiateCandidateVerificationCall({
    agentId: TEMPLATE,
    formattedPhone: '+919800000000',
    candidate: { fullName: 'Ada Lovelace', email: 'ada@example.com', skills: [], address: { city: 'Pune' } },
    job: { _id: 'job1', title: 'Engineer', interviewerPool: [{ _id: 'user1' }] },
    application: { _id: 'app123', createdAt: new Date('2026-09-14T00:00:00Z') },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /interview tools are not verified/i);
});
