/**
 * Run: npm run test:attendance-duration
 * (Jest in this repo does not transform ESM .js sources; Node's test runner loads them directly.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDurationMs } from '../../../src/utils/attendanceDuration.js';

test('returns raw wall time when shift is null', () => {
  const a = new Date('2025-06-15T10:00:00.000Z');
  const b = new Date('2025-06-15T14:30:00.000Z');
  assert.equal(computeDurationMs(a, b, null), 4.5 * 60 * 60 * 1000);
});

test('returns raw wall time when shift is incomplete', () => {
  const a = new Date('2025-06-15T10:00:00.000Z');
  const b = new Date('2025-06-15T12:00:00.000Z');
  assert.equal(computeDurationMs(a, b, { startTime: '09:00', endTime: '17:00' }), 2 * 60 * 60 * 1000);
});

test('clips to shift window overlap (Asia/Kolkata)', () => {
  const shift = { startTime: '09:00', endTime: '17:00', timezone: 'Asia/Kolkata' };
  const punchIn = new Date('2025-06-15T03:30:00.000Z');
  const punchOut = new Date('2025-06-15T11:30:00.000Z');
  const wall = punchOut.getTime() - punchIn.getTime();
  const ms = computeDurationMs(punchIn, punchOut, shift);
  assert.ok(ms > 0, 'overlap should be positive');
  assert.ok(ms <= wall, 'clipped duration must not exceed wall time');
});
