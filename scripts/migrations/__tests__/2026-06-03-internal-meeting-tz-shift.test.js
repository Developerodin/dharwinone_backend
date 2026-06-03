import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneOffsetMinutes,
  correctScheduledAt,
  UTC_EQUIVALENT,
} from '../2026-06-03-internal-meeting-tz-shift.js';

test('zoneOffsetMinutes returns +330 for Asia/Calcutta (IST, no DST)', () => {
  assert.equal(zoneOffsetMinutes('Asia/Calcutta', new Date('2026-06-01T20:00:00.000Z')), 330);
  assert.equal(zoneOffsetMinutes('Asia/Kolkata', new Date('2026-06-01T20:00:00.000Z')), 330);
});

test('zoneOffsetMinutes returns 0 for UTC and for an invalid zone', () => {
  assert.equal(zoneOffsetMinutes('UTC', new Date('2026-06-01T20:00:00.000Z')), 0);
  assert.equal(zoneOffsetMinutes('Not/AZone', new Date('2026-06-01T20:00:00.000Z')), 0);
});

test('correctScheduledAt: IST 8:00 PM stored as 20:00 UTC is corrected to 14:30 UTC', () => {
  // Reproduces the reported bug: 8:00 PM IST mis-stored as 20:00 UTC -> email showed 1:30 AM.
  const corrupted = new Date('2026-06-01T20:00:00.000Z');
  const corrected = correctScheduledAt(corrupted, 'Asia/Calcutta');
  assert.equal(corrected.toISOString(), '2026-06-01T14:30:00.000Z');
});

test('correctScheduledAt: UTC-zone meetings are untouched (no double-shift)', () => {
  const d = new Date('2026-06-01T20:00:00.000Z');
  for (const tz of UTC_EQUIVALENT) {
    assert.equal(correctScheduledAt(d, tz).getTime(), d.getTime());
  }
});

test('correctScheduledAt: handles America/New_York (negative offset)', () => {
  // EDT in June is UTC-4. A 9:00 AM EDT meeting mis-stored as 09:00 UTC -> correct is 13:00 UTC.
  const corrupted = new Date('2026-06-01T09:00:00.000Z');
  const corrected = correctScheduledAt(corrupted, 'America/New_York');
  assert.equal(corrected.toISOString(), '2026-06-01T13:00:00.000Z');
});

test('correctScheduledAt: invalid date returned as-is', () => {
  const bad = new Date('not-a-date');
  assert.ok(Number.isNaN(correctScheduledAt(bad, 'Asia/Calcutta').getTime()));
});
