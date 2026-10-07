import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

const lifecycleMarks = [];
const lifecycleSeeds = [];
const callEventRows = [];
let callRecordTemplate = {
  _id: 'rec-1',
  executionId: 'exec-1',
  status: 'initiated',
  statusRank: 1,
  statusUpdatedAt: new Date(),
  ownedClone: true,
  agentId: 'clone-agent-1',
};

mock.module('../bolnaCloneLifecycle.service.js', {
  namedExports: {
    markCloneTerminalEvent: async (payload) => {
      lifecycleMarks.push(payload);
      return { ok: true };
    },
    upsertCloneLifecycleFromSeed: async (payload) => {
      lifecycleSeeds.push(payload);
      return { ok: true };
    },
  },
});

mock.module('../../models/callEvent.model.js', {
  defaultExport: {
    create: async (payload) => {
      callEventRows.push(payload);
      return payload;
    },
  },
});

mock.module('../../models/callRecord.model.js', {
  defaultExport: {
    findOneAndUpdate: (_filter, update) => ({
      lean: async () => {
        if (update.$setOnInsert) {
          return {
            ...callRecordTemplate,
            ...update.$setOnInsert,
            status: update.$setOnInsert.status || 'initiated',
            statusRank: update.$setOnInsert.statusRank ?? 1,
            statusUpdatedAt: update.$setOnInsert.statusUpdatedAt || new Date(),
          };
        }
        return {
          ...callRecordTemplate,
          ...update.$set,
        };
      },
    }),
    findOne: () => ({
      select: () => ({
        lean: async () => ({
          executionId: callRecordTemplate.executionId,
          status: callRecordTemplate.status,
          statusRank: callRecordTemplate.statusRank,
          statusUpdatedAt: callRecordTemplate.statusUpdatedAt,
        }),
      }),
      lean: async () => ({
        executionId: callRecordTemplate.executionId,
        status: callRecordTemplate.status,
        statusRank: callRecordTemplate.statusRank,
        statusUpdatedAt: callRecordTemplate.statusUpdatedAt,
      }),
    }),
    updateOne: async () => ({ modifiedCount: 1 }),
    exists: async () => null,
    create: async (payload) => payload,
  },
  namedExports: {
    STATUS_RANK: { unknown: 0, initiated: 1, completed: 10, failed: 10, call_disconnected: 10 },
    TERMINAL_STATUSES: ['completed', 'failed', 'call_disconnected'],
    rankOf: (s) => ({ unknown: 0, initiated: 1, in_progress: 3, completed: 10, failed: 10, call_disconnected: 10 }[s] ?? 0),
    isTerminal: (s) => ['completed', 'failed', 'call_disconnected'].includes(String(s || '').toLowerCase()),
  },
});

mock.module('../callRecord.service.js', {
  defaultExport: {
    normalizePayload: (payload) => ({
      executionId: payload.id || payload.execution_id || payload.executionId || 'exec-1',
      status: payload.status || payload.smart_status || 'completed',
      transcript: payload.transcript || undefined,
      telephonyData: payload.telephony_data || undefined,
      agentId: payload.agent_id || undefined,
    }),
  },
});

mock.module('../bolnaOwnedAgents.js', {
  namedExports: {
    isRegisteredCloneAgent: () => false,
    registerOwnedCloneAgent: () => {},
  },
});

mock.module('../bolna.service.js', {
  defaultExport: {
    getAgentExecutions: async () => ({ success: true, data: [], has_more: false }),
    verifyExecutionExistsInBolna: async () => ({ exists: true }),
  },
});

let callSyncService;

before(async () => {
  callSyncService = await import('../callSync.service.js');
});

test.beforeEach(() => {
  lifecycleMarks.length = 0;
  lifecycleSeeds.length = 0;
  callEventRows.length = 0;
  callRecordTemplate = {
    _id: 'rec-1',
    executionId: 'exec-1',
    status: 'initiated',
    statusRank: 1,
    statusUpdatedAt: new Date(),
    ownedClone: true,
    agentId: 'clone-agent-1',
  };
});

test('terminal applyEvent marks clone lifecycle instead of immediate delete path', async () => {
  const result = await callSyncService.applyEvent(
    {
      id: 'exec-1',
      status: 'completed',
      smart_status: 'done',
      updated_at: new Date().toISOString(),
    },
    'webhook'
  );

  assert.equal(result.applied, true);
  assert.equal(lifecycleMarks.length, 1);
  assert.equal(lifecycleMarks[0].executionId, 'exec-1');
  assert.equal(lifecycleMarks[0].cloneAgentId, 'clone-agent-1');
  assert.equal(lifecycleMarks[0].status, 'completed');
});

test('seedRecord for owned clone seeds lifecycle metadata once', async () => {
  await callSyncService.seedRecord({
    executionId: 'exec-seed-1',
    agentId: 'clone-agent-seed',
    ownedClone: true,
    promptRenderToken: 'render-1',
    promptHash: 'a'.repeat(64),
    question1: 'Is your name Ada Lovelace?',
    agentVersionId: 'v-123',
    promptTextSnapshot: 'prompt text',
    cloneRequestSnapshot: { agent_prompts: { task_1: { system_prompt: 'prompt text' } } },
  });

  assert.equal(lifecycleSeeds.length, 1);
  assert.equal(lifecycleSeeds[0].executionId, 'exec-seed-1');
  assert.equal(lifecycleSeeds[0].cloneAgentId, 'clone-agent-seed');
  assert.equal(lifecycleSeeds[0].cloneAgentVersionId, 'v-123');
  assert.equal(lifecycleSeeds[0].promptRenderToken, 'render-1');
});
