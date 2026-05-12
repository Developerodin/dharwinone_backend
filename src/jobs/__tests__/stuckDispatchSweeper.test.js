import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeartbeatStale } from '../stuckDispatchSweeper.js';

test('isHeartbeatStale true when lastHeartbeat is older than threshold', () => {
  const old = new Date(Date.now() - 120000);
  assert.equal(isHeartbeatStale(old, 90000), true);
});

test('isHeartbeatStale false when fresh', () => {
  const fresh = new Date(Date.now() - 30000);
  assert.equal(isHeartbeatStale(fresh, 90000), false);
});

test('isHeartbeatStale false when null', () => {
  assert.equal(isHeartbeatStale(null, 90000), false);
});
