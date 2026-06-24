import test from 'node:test';
import assert from 'node:assert/strict';
import { resignBucket, RESIGN_SOON_WINDOW_DAYS } from '../resignBucket.js';

const NOW = new Date('2026-06-23T10:00:00.000Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

test('window constant is 30', () => {
  assert.strictEqual(RESIGN_SOON_WINDOW_DAYS, 30);
});

test('null / undefined resignDate => null', () => {
  assert.strictEqual(resignBucket(null, NOW), null);
  assert.strictEqual(resignBucket(undefined, NOW), null);
});

test('resignDate in the past => resigned', () => {
  assert.strictEqual(resignBucket(daysFromNow(-1), NOW), 'resigned');
});

test('resignDate today (<= now) => resigned', () => {
  assert.strictEqual(resignBucket(NOW, NOW), 'resigned');
});

test('resignDate within 30 days => soon', () => {
  assert.strictEqual(resignBucket(daysFromNow(1), NOW), 'soon');
  assert.strictEqual(resignBucket(daysFromNow(30), NOW), 'soon');
});

test('resignDate beyond 30 days => null', () => {
  assert.strictEqual(resignBucket(daysFromNow(31), NOW), null);
});

test('accepts ISO string', () => {
  assert.strictEqual(resignBucket(daysFromNow(5).toISOString(), NOW), 'soon');
});
