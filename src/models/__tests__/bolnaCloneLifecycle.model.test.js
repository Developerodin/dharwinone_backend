import test from 'node:test';
import assert from 'node:assert/strict';

import BolnaCloneLifecycle from '../bolnaCloneLifecycle.model.js';

test('BolnaCloneLifecycle defaults to initiated/pending states', () => {
  const row = new BolnaCloneLifecycle({
    executionId: 'exec-1',
    cloneAgentId: 'clone-1',
  });
  assert.equal(row.state, 'initiated');
  assert.equal(row.snapshot.status, 'pending');
  assert.equal(row.cleanup.status, 'pending');
});

test('BolnaCloneLifecycle rejects unknown lifecycle state', () => {
  const row = new BolnaCloneLifecycle({
    executionId: 'exec-2',
    cloneAgentId: 'clone-2',
    state: 'unknown_state',
  });
  const err = row.validateSync();
  assert.ok(err);
  assert.ok(err.errors.state);
});
