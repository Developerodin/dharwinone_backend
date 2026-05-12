import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_QUEUE, summaryQueueOptions } from '../summaryQueue.js';

test('SUMMARY_QUEUE has a stable name', () => {
  assert.equal(SUMMARY_QUEUE, 'summary.finalize');
});

test('summaryQueueOptions sets attempts=3 and exponential backoff', () => {
  const o = summaryQueueOptions();
  assert.equal(o.defaultJobOptions.attempts, 3);
  assert.equal(o.defaultJobOptions.backoff.type, 'exponential');
  assert.equal(o.defaultJobOptions.removeOnFail, false);
});
