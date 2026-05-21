import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimezone, isValidTimezone, formatInZone } from '../timezone.js';

test('normalizeTimezone maps legacy alias and defaults blank to UTC', () => {
  assert.equal(normalizeTimezone('Asia/Calcutta'), 'Asia/Kolkata');
  assert.equal(normalizeTimezone(' Asia/Calcutta '), 'Asia/Kolkata');
  assert.equal(normalizeTimezone(''), 'UTC');
  assert.equal(normalizeTimezone(null), 'UTC');
  assert.equal(normalizeTimezone(undefined), 'UTC');
  assert.equal(normalizeTimezone('America/New_York'), 'America/New_York');
});

test('isValidTimezone accepts real zones and rejects garbage', () => {
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Asia/Kolkata'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
  assert.equal(isValidTimezone(''), false);
});

test('formatInZone renders the instant in the given zone with a label', () => {
  const instant = new Date('2026-05-20T11:00:00.000Z');
  const utc = formatInZone(instant, 'UTC');
  assert.match(utc, /2026/);
  assert.match(utc, /11:00/);
  const ist = formatInZone(instant, 'Asia/Calcutta');
  assert.match(ist, /16:30|4:30/);
});
