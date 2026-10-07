import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

const aggregateMock = mock.fn(async () => []);

mock.module('../../config/logger.js', {
  exports: { default: { info: () => {}, warn: () => {}, error: () => {} } },
});

mock.module('../../config/config.js', {
  exports: {
    default: {
      bolna: { cloneLifecycle: { staleRepairBatchSize: 2 }, allAgentIds: [] },
    },
  },
});

mock.module('../../models/bolnaCloneLifecycle.model.js', {
  exports: {
    default: {
      collection: { name: 'bolnaclonecycles' },
    },
  },
});

mock.module('../../models/callRecord.model.js', {
  exports: {
    default: {
      aggregate: aggregateMock,
    },
    isTerminal: () => false,
  },
});

mock.module('../bolna.service.js', {
  exports: { default: {} },
});

mock.module('../bolnaOwnedAgents.js', {
  exports: { unregisterOwnedCloneAgent: () => {} },
});

let buildMissingLifecycleRepairPipeline;
let findCallRecordsMissingLifecycle;
let REPAIR_MIN_RECORD_AGE_MS;

before(async () => {
  const mod = await import('../bolnaCloneLifecycle.service.js');
  buildMissingLifecycleRepairPipeline = mod.__testables.buildMissingLifecycleRepairPipeline;
  findCallRecordsMissingLifecycle = mod.__testables.findCallRecordsMissingLifecycle;
  REPAIR_MIN_RECORD_AGE_MS = mod.__testables.REPAIR_MIN_RECORD_AGE_MS;
});

test.beforeEach(() => {
  aggregateMock.mock.resetCalls();
});

test('repair pipeline joins lifecycle and selects oldest missing rows first', () => {
  const cutoff = new Date('2026-01-01T00:00:00.000Z');
  const pipeline = buildMissingLifecycleRepairPipeline(cutoff, 20, 'bolnaclonecycles');

  assert.deepEqual(pipeline[0].$match.createdAt, { $lte: cutoff });
  assert.equal(pipeline[1].$lookup.from, 'bolnaclonecycles');
  assert.equal(pipeline[1].$lookup.localField, 'executionId');
  assert.deepEqual(pipeline[2].$match, { _lifecycleJoin: { $eq: [] } });
  assert.deepEqual(pipeline[3].$sort, { createdAt: 1, _id: 1 });
  assert.equal(pipeline[4].$limit, 20);
});

test('findCallRecordsMissingLifecycle returns oldest missing row (not newest owned-clone window)', async () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const oldMissing = {
    _id: 'rec-old',
    executionId: 'exec-old-missing',
    agentId: 'clone-old',
    status: 'completed',
    statusUpdatedAt: new Date('2026-05-01T00:00:00.000Z'),
  };

  aggregateMock.mock.mockImplementationOnce(async (pipeline) => {
    const sortStage = pipeline.find((stage) => stage.$sort);
    assert.deepEqual(sortStage.$sort, { createdAt: 1, _id: 1 });
    const missingJoinStage = pipeline.find((stage) => stage.$match?._lifecycleJoin);
    assert.ok(missingJoinStage);
    const cutoffStage = pipeline[0].$match.createdAt.$lte;
    assert.equal(cutoffStage.getTime(), now.getTime() - REPAIR_MIN_RECORD_AGE_MS);
    return [oldMissing];
  });

  const rows = await findCallRecordsMissingLifecycle(now, 2);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].executionId, 'exec-old-missing');
  assert.equal(aggregateMock.mock.callCount(), 1);
});

test('findCallRecordsMissingLifecycle passes configured batch size as aggregation limit', async () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  aggregateMock.mock.mockImplementationOnce(async (pipeline) => {
    const limitStage = pipeline.find((stage) => stage.$limit !== undefined);
    assert.equal(limitStage.$limit, 2);
    return [];
  });

  const rows = await findCallRecordsMissingLifecycle(now, 2);
  assert.deepEqual(rows, []);
});
