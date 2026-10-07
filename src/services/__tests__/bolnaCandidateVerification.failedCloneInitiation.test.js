import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const deleteAgentCalls = [];
const registerCalls = [];
const unregisterCalls = [];
let registerShouldFail = true;
let registerFailCount = 1;
let deleteAgentResult = { success: true };

mock.module('../../config/logger.js', {
  defaultExport: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
});

mock.module('../bolna.service.js', {
  defaultExport: {
    getAgent: async () => ({
      success: true,
      agent: {
        agent_name: 'Template',
        agent_welcome_message: 'Welcome',
        agent_prompts: { task_1: { system_prompt: 'Original' } },
        tasks: [{ task_type: 'conversation', tools_config: {} }],
      },
    }),
    createAgent: async () => ({ success: true, agentId: 'clone-fail-1', versionId: 'v-1' }),
    initiateCall: async () => ({ success: false, error: 'upstream_rejected' }),
    deleteAgent: async (agentId) => {
      deleteAgentCalls.push(agentId);
      return deleteAgentResult;
    },
  },
});

mock.module('../bolnaCandidateAgentSettings.service.js', {
  namedExports: {
    getBolnaCandidateAgentSettingsForPrompt: async () => ({
      greetingOverride: null,
      extraSystemInstructions: '',
    }),
  },
});

mock.module('../candidateVerificationPrompt.service.js', {
  namedExports: {
    buildCandidateAgentPromptTemplate: () => 'static prompt',
    buildCandidateAgentTemplateVars: () => ({
      candidate_verification_q1_line: 'Is your name Jane?',
      candidate_verification_q2_line: 'The position you applied for is listed as Engineer. Can you confirm that?',
    }),
    buildCandidateVerificationPromptContext: async () => ({
      candidate_name: 'Jane Doe',
      job_title: 'Engineer',
      company_name: 'Acme',
      candidate_phone: '+911234567890',
      candidate_email: 'jane@example.com',
      candidate_email_spoken: 'jane at example dot com',
      candidate_location: 'Mumbai',
      candidate_skills: '',
      application_date: '1 January 2026',
      matched_jobs_count: 0,
      matched_jobs_spoken: '',
      interview_scheduling_enabled: 'no',
      application_id: '',
      candidate_timezone: 'Asia/Kolkata',
      candidate_timezone_spoken: 'India time',
    }),
    renderPromptTemplateWithVars: (template) => template,
    resolveCandidateAgentGreeting: () => 'Hi there',
  },
});

mock.module('../kbQuery.service.js', {
  namedExports: {
    getKbPromptContextForExternalAgent: async () => null,
  },
});

mock.module('../bolnaCandidateToolsSetup.service.js', {
  namedExports: {
    buildCandidateToolsPutBody: (_agent, _null, overrides) => ({
      agent_config: {
        agent_name: overrides.agentName || 'clone',
        tasks: [{ task_type: 'conversation', tools_config: {} }],
      },
      agent_prompts: { task_1: { system_prompt: overrides.systemPrompt || 'prompt' } },
    }),
    ensureCandidateInterviewTools: async () => ({ success: true, persisted: true }),
    interviewSchedulingToolsVerified: () => true,
    templateCanBeCloned: () => ({ ok: true }),
  },
});

mock.module('../bolnaCloneLifecycle.service.js', {
  namedExports: {
    registerFailedCloneInitiation: async (payload) => {
      registerCalls.push(payload);
      if (registerShouldFail && registerCalls.length <= registerFailCount) {
        throw new Error('lifecycle_write_failed');
      }
      return {};
    },
  },
});

mock.module('../bolnaOwnedAgents.js', {
  namedExports: {
    registerOwnedCloneAgent: () => {},
    unregisterOwnedCloneAgent: (agentId) => {
      unregisterCalls.push(agentId);
    },
  },
});

mock.module('../../utils/bolnaAgentConfig.js', {
  namedExports: {
    assertQ2LineMatchesJobTitle: () => ({ ok: true }),
    assertUserDataWithinLimit: () => ({ ok: true, bytes: 100 }),
    bolnaJobAndCandidateAgentsCollide: () => false,
    missingTemplateVars: () => [],
  },
});

let initiateCandidateVerificationCall;

test.before(async () => {
  const mod = await import('../bolnaCandidateVerification.service.js');
  initiateCandidateVerificationCall = mod.initiateCandidateVerificationCall;
});

test.beforeEach(() => {
  deleteAgentCalls.length = 0;
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  registerShouldFail = true;
  registerFailCount = 1;
  deleteAgentResult = { success: true };
});

test('failed dial deletes orphan clone when lifecycle register fails', async () => {
  const result = await initiateCandidateVerificationCall({
    agentId: 'template-agent-1',
    formattedPhone: '+911234567890',
    candidate: { _id: 'cand-1', fullName: 'Jane Doe' },
    job: { _id: 'job-1', title: 'Engineer', organisation: 'Acme' },
  });

  assert.equal(result.success, false);
  assert.deepEqual(deleteAgentCalls, ['clone-fail-1']);
  assert.deepEqual(unregisterCalls, ['clone-fail-1']);
});

test('failed dial does not delete clone when lifecycle register succeeds', async () => {
  registerShouldFail = false;

  const result = await initiateCandidateVerificationCall({
    agentId: 'template-agent-1',
    formattedPhone: '+911234567890',
    candidate: { _id: 'cand-1', fullName: 'Jane Doe' },
    job: { _id: 'job-1', title: 'Engineer', organisation: 'Acme' },
  });

  assert.equal(result.success, false);
  assert.equal(deleteAgentCalls.length, 0);
  assert.equal(registerCalls.length, 1);
  assert.deepEqual(unregisterCalls, ['clone-fail-1']);
});

test('failed dial registers orphan lifecycle when delete returns unsuccessful', async () => {
  deleteAgentResult = { success: false, error: 'bolna_api_down' };

  const result = await initiateCandidateVerificationCall({
    agentId: 'template-agent-1',
    formattedPhone: '+911234567890',
    candidate: { _id: 'cand-1', fullName: 'Jane Doe' },
    job: { _id: 'job-1', title: 'Engineer', organisation: 'Acme' },
  });

  assert.equal(result.success, false);
  assert.deepEqual(deleteAgentCalls, ['clone-fail-1']);
  assert.equal(registerCalls.length, 2);
  assert.match(registerCalls[1].errorMessage, /orphan_delete_failed:bolna_api_down/);
  assert.deepEqual(unregisterCalls, ['clone-fail-1']);
});
