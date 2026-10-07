import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

const lifecycleSeeds = [];
let insertedOnSeed = null;

mock.module('../bolnaCloneLifecycle.service.js', {
  namedExports: {
    markCloneTerminalEvent: async () => ({ ok: true }),
    upsertCloneLifecycleFromSeed: async (payload) => {
      lifecycleSeeds.push(payload);
      return { ok: true };
    },
  },
});

mock.module('../../models/callEvent.model.js', {
  defaultExport: {
    create: async () => ({}),
  },
});

mock.module('../../models/callRecord.model.js', {
  defaultExport: {
    findOneAndUpdate: (_filter, update) => ({
      lean: async () => {
        insertedOnSeed = update.$setOnInsert || null;
        return {
          _id: 'rec-seed-1',
          executionId: insertedOnSeed?.executionId,
          status: 'initiated',
          ownedClone: insertedOnSeed?.ownedClone,
          agentId: insertedOnSeed?.agentId,
        };
      },
    }),
    updateOne: async () => ({ modifiedCount: 0 }),
    exists: async () => null,
  },
  namedExports: {
    STATUS_RANK: { initiated: 1 },
    TERMINAL_STATUSES: [],
    rankOf: () => 1,
    isTerminal: () => false,
  },
});

mock.module('../callRecord.service.js', {
  defaultExport: {
    normalizePayload: (payload) => payload,
  },
});

mock.module('../bolnaOwnedAgents.js', {
  namedExports: {
    isRegisteredCloneAgent: () => false,
    registerOwnedCloneAgent: () => {},
  },
});

mock.module('../bolna.service.js', {
  defaultExport: {},
});

mock.module('../../config/config.js', {
  defaultExport: { bolna: { executionContext: null } },
});

let callSyncService;
let candidateVerificationSeedBody;

before(async () => {
  ({ candidateVerificationSeedBody } = await import('../candidateVerificationCallSeed.js'));
  callSyncService = await import('../callSync.service.js');
});

test.beforeEach(() => {
  lifecycleSeeds.length = 0;
  insertedOnSeed = null;
});

test('candidateVerificationSeedBody includes ownedClone for per-call clone dials', () => {
  const body = candidateVerificationSeedBody(
    {
      executionId: 'exec-owned-1',
      agentId: 'clone-agent-9',
      ownedClone: true,
      promptRenderToken: 'render-token',
      promptHash: 'a'.repeat(64),
    },
    { candidateId: 'cand-1', jobId: 'job-1', recipientPhone: '+911234567890' }
  );

  assert.equal(body.ownedClone, true);
  assert.equal(body.executionId, 'exec-owned-1');
  assert.equal(body.agentId, 'clone-agent-9');
});

test('seedRecord persists ownedClone from candidate verification seed body', async () => {
  const seedArgs = candidateVerificationSeedBody(
    {
      executionId: 'exec-owned-2',
      agentId: 'clone-agent-10',
      ownedClone: true,
      promptRenderToken: 'render-2',
      promptHash: 'b'.repeat(64),
      agentVersionId: 'ver-1',
    },
    { recipientPhone: '+911234567890' }
  );

  await callSyncService.seedRecord(seedArgs);

  assert.equal(insertedOnSeed?.ownedClone, true);
  assert.equal(insertedOnSeed?.agentId, 'clone-agent-10');
  assert.equal(lifecycleSeeds.length, 1);
  assert.equal(lifecycleSeeds[0].cloneAgentId, 'clone-agent-10');
});
