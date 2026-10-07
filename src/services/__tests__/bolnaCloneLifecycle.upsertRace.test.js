import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

const existingRow = {
  executionId: 'exec-race',
  cloneAgentId: 'clone-race',
  state: 'initiated',
  snapshot: { status: 'pending', attempts: 0, maxAttempts: 8 },
  cleanup: { status: 'pending', attempts: 0, maxAttempts: 6 },
  prompt: {},
  save: async () => existingRow,
  toObject() {
    return { ...existingRow };
  },
};

let findOneResults = [];
const findOneMock = mock.fn(async () => {
  const next = findOneResults.shift();
  return next === undefined ? null : next;
});

class LifecycleDoc {
  constructor(data) {
    Object.assign(this, data);
    this.state = 'initiated';
    this.snapshot = { status: 'pending', attempts: 0, maxAttempts: 8, payload: {}, missingSections: [] };
    this.cleanup = { status: 'pending', attempts: 0, maxAttempts: 6 };
    this.prompt = {};
    this.terminal = {};
    this.audit = {};
    this.save = async () => {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    };
  }

  toObject() {
    return {
      executionId: this.executionId,
      cloneAgentId: this.cloneAgentId,
      state: this.state,
    };
  }
}

mock.module('../../config/logger.js', {
  exports: { default: { info: () => {}, warn: () => {}, error: () => {} } },
});

mock.module('../../config/config.js', {
  exports: {
    default: {
      bolna: { cloneLifecycle: {}, allAgentIds: [] },
    },
  },
});

mock.module('../../models/callRecord.model.js', {
  exports: {
    default: {},
    isTerminal: () => false,
  },
});

mock.module('../bolna.service.js', {
  exports: { default: {} },
});

mock.module('../bolnaOwnedAgents.js', {
  exports: { unregisterOwnedCloneAgent: () => {} },
});

mock.module('../../models/bolnaCloneLifecycle.model.js', {
  exports: {
    default: Object.assign(LifecycleDoc, { findOne: findOneMock }),
  },
});

let findOrCreateLifecycleRowByExecutionId;

before(async () => {
  const mod = await import('../bolnaCloneLifecycle.service.js');
  findOrCreateLifecycleRowByExecutionId = mod.__testables.findOrCreateLifecycleRowByExecutionId;
});

test('findOrCreateLifecycleRowByExecutionId tolerates duplicate-key race on insert', async () => {
  findOneMock.mock.resetCalls();
  findOneResults = [null, existingRow];

  const row = await findOrCreateLifecycleRowByExecutionId({
    executionId: 'exec-race',
    cloneAgentId: 'clone-race',
  });

  assert.equal(row, existingRow);
  assert.equal(findOneMock.mock.callCount(), 2);
});
