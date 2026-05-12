import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSegmentBatch } from '../../controllers/agentInternal.controller.js';

test('validateSegmentBatch rejects empty array', () => {
  const r = validateSegmentBatch([]);
  assert.equal(r.ok, false);
});

test('validateSegmentBatch rejects batch over limit', () => {
  const huge = Array.from({ length: 51 }, (_, i) => ({
    sequenceNumber: i,
    windowStartMs: i * 30000,
    windowEndMs: (i + 1) * 30000,
    combinedText: 'x',
    utterances: [],
  }));
  const r = validateSegmentBatch(huge, 50);
  assert.equal(r.ok, false);
});

test('validateSegmentBatch accepts a normal batch', () => {
  const r = validateSegmentBatch([
    { sequenceNumber: 0, windowStartMs: 0, windowEndMs: 30000, combinedText: 'hi', utterances: [] },
  ]);
  assert.equal(r.ok, true);
});

test('validateSegmentBatch rejects missing required fields', () => {
  const r = validateSegmentBatch([{ sequenceNumber: 0 }]);
  assert.equal(r.ok, false);
});
