import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEventId, computeBodyHash } from '../webhookIdempotency.service.js';

test('computeBodyHash produces stable sha256 hex', () => {
  const h1 = computeBodyHash('{"a":1}');
  const h2 = computeBodyHash('{"a":1}');
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test('computeEventId prefers explicit id header', () => {
  const id = computeEventId({ explicitId: 'lk-evt-123', timestamp: '1700000000', body: 'x' });
  assert.equal(id, 'lk-evt-123');
});

test('computeEventId falls back to sha256(timestamp + bodyHash)', () => {
  const id1 = computeEventId({ explicitId: null, timestamp: '1700000000', body: 'x' });
  const id2 = computeEventId({ explicitId: null, timestamp: '1700000000', body: 'x' });
  const id3 = computeEventId({ explicitId: null, timestamp: '1700000000', body: 'y' });
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});
