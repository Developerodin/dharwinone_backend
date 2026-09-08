import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reminderRetryDefaults,
  needsBackfill,
} from '../2026-09-08-backfill-meeting-reminder-retry.js';

test('the default subdocument has attempts 0 so a $lt filter matches it', () => {
  const d = reminderRetryDefaults();
  assert.equal(d.attempts, 0);
  assert.equal(d.claimedAt, null);
  assert.equal(d.failedAt, null);
});

test('a document missing either counter needs backfilling', () => {
  assert.equal(needsBackfill({ _id: 1 }), true);
  assert.equal(needsBackfill({ _id: 1, reminderRetry: {} }), true);
  assert.equal(needsBackfill({ _id: 1, conclusionRetry: { attempts: 0 } }), true);
});

test('a document with both counters present does not', () => {
  assert.equal(
    needsBackfill({ _id: 1, reminderRetry: { attempts: 0 }, conclusionRetry: { attempts: 2 } }),
    false
  );
});

test('the defaults object is a fresh copy each call', () => {
  const a = reminderRetryDefaults();
  a.attempts = 99;
  assert.equal(reminderRetryDefaults().attempts, 0);
});
