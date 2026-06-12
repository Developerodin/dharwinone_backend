import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOccurrences,
  buildRRuleString,
  recurrenceLabel,
  clampSeriesStartAt,
  seriesMaterializationFloor,
} from '../recurrence.util.js';
import { wallClockToUtc, wallClockPartsInZone } from '../timezone.js';

const series = (overrides = {}) => ({
  timezone: 'Asia/Kolkata',
  startAt: wallClockToUtc({ year: 2026, month: 6, day: 15, hour: 9, minute: 30 }, 'Asia/Kolkata'),
  durationMinutes: 30,
  recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [1, 3] },
  end: { mode: 'never' },
  ...overrides,
});

const horizon = new Date(Date.UTC(2026, 11, 31));

test('wallClockToUtc round-trips through wallClockPartsInZone', () => {
  const utc = wallClockToUtc({ year: 2026, month: 6, day: 15, hour: 9, minute: 30 }, 'Asia/Kolkata');
  assert.equal(utc.toISOString(), '2026-06-15T04:00:00.000Z'); // IST = UTC+5:30
  const parts = wallClockPartsInZone(utc, 'Asia/Kolkata');
  assert.deepEqual(
    { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute },
    { y: 2026, mo: 6, d: 15, h: 9, mi: 30 }
  );
});

test('weekly Mon/Wed with afterCount yields exactly N occurrences, indexed from 0', () => {
  const s = series({ end: { mode: 'afterCount', count: 4 } });
  const occ = generateOccurrences(s, horizon);
  assert.equal(occ.length, 4);
  assert.deepEqual(occ.map((o) => o.index), [0, 1, 2, 3]);
  // Mon 15, Wed 17, Mon 22, Wed 24 — all 09:30 IST (04:00Z).
  assert.deepEqual(
    occ.map((o) => o.at.toISOString()),
    ['2026-06-15T04:00:00.000Z', '2026-06-17T04:00:00.000Z', '2026-06-22T04:00:00.000Z', '2026-06-24T04:00:00.000Z']
  );
});

test('daily interval>1 spaces occurrences correctly', () => {
  const s = series({
    recurrence: { frequency: 'daily', interval: 3 },
    end: { mode: 'afterCount', count: 3 },
  });
  const occ = generateOccurrences(s, horizon);
  assert.deepEqual(
    occ.map((o) => o.at.toISOString()),
    ['2026-06-15T04:00:00.000Z', '2026-06-18T04:00:00.000Z', '2026-06-21T04:00:00.000Z']
  );
});

test('monthly on day-of-month', () => {
  const s = series({
    startAt: wallClockToUtc({ year: 2026, month: 1, day: 10, hour: 9, minute: 0 }, 'Asia/Kolkata'),
    recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 10 },
    end: { mode: 'afterCount', count: 3 },
  });
  const occ = generateOccurrences(s, horizon);
  const days = occ.map((o) => wallClockPartsInZone(o.at, 'Asia/Kolkata').day);
  assert.deepEqual(days, [10, 10, 10]);
  assert.equal(occ.length, 3);
});

test('end onDate is inclusive of the end day and excludes later occurrences', () => {
  const s = series({
    recurrence: { frequency: 'daily', interval: 1 },
    end: { mode: 'onDate', untilDate: wallClockToUtc({ year: 2026, month: 6, day: 18, hour: 0, minute: 0 }, 'Asia/Kolkata') },
  });
  const occ = generateOccurrences(s, horizon);
  // 15,16,17,18 inclusive
  assert.equal(occ.length, 4);
  assert.equal(wallClockPartsInZone(occ[occ.length - 1].at, 'Asia/Kolkata').day, 18);
});

test('DST: US/Eastern daily keeps local wall-clock across the Nov DST change', () => {
  const s = series({
    timezone: 'America/New_York',
    startAt: wallClockToUtc({ year: 2026, month: 10, day: 31, hour: 10, minute: 0 }, 'America/New_York'),
    recurrence: { frequency: 'daily', interval: 1 },
    end: { mode: 'afterCount', count: 4 },
  });
  const occ = generateOccurrences(s, new Date(Date.UTC(2026, 11, 1)));
  // All should read 10:00 local even though the UTC offset shifts on Nov 1.
  for (const o of occ) {
    assert.equal(wallClockPartsInZone(o.at, 'America/New_York').hour, 10);
  }
  // UTC instant must actually shift by an hour across the boundary (EDT->EST).
  assert.equal(occ[0].at.toISOString(), '2026-10-31T14:00:00.000Z');
  assert.equal(occ[1].at.toISOString(), '2026-11-01T15:00:00.000Z');
});

test('generateOccurrences is deterministic / stable index across re-runs', () => {
  const s = series({ end: { mode: 'afterCount', count: 5 } });
  const a = generateOccurrences(s, horizon).map((o) => o.at.toISOString());
  const b = generateOccurrences(s, horizon).map((o) => o.at.toISOString());
  assert.deepEqual(a, b);
});

test('buildRRuleString emits a valid RRULE line', () => {
  const s = series({ end: { mode: 'afterCount', count: 4 } });
  const rrule = buildRRuleString(s);
  assert.match(rrule, /FREQ=WEEKLY/);
  assert.match(rrule, /BYDAY=MO,WE/);
  assert.match(rrule, /COUNT=4/);
  assert.ok(!rrule.startsWith('RRULE:'), 'value should not include the RRULE: prefix');
});

test('clampSeriesStartAt anchors a past requested start to the creation day wall-clock', () => {
  const requested = wallClockToUtc({ year: 2026, month: 9, day: 3, hour: 12, minute: 15 }, 'Asia/Kolkata');
  const created = wallClockToUtc({ year: 2026, month: 9, day: 9, hour: 10, minute: 0 }, 'Asia/Kolkata');
  const clamped = clampSeriesStartAt(requested, created, 'Asia/Kolkata');
  assert.equal(clamped.toISOString(), '2026-09-09T06:45:00.000Z'); // Sep 9 12:15 IST
});

test('clampSeriesStartAt leaves a future start unchanged', () => {
  const requested = wallClockToUtc({ year: 2026, month: 9, day: 15, hour: 9, minute: 0 }, 'Asia/Kolkata');
  const created = wallClockToUtc({ year: 2026, month: 9, day: 9, hour: 10, minute: 0 }, 'Asia/Kolkata');
  const clamped = clampSeriesStartAt(requested, created, 'Asia/Kolkata');
  assert.equal(clamped.toISOString(), requested.toISOString());
});

test('seriesMaterializationFloor never materializes before now', () => {
  const requested = wallClockToUtc({ year: 2026, month: 9, day: 1, hour: 13, minute: 45 }, 'Asia/Kolkata');
  const created = wallClockToUtc({ year: 2026, month: 9, day: 7, hour: 10, minute: 0 }, 'Asia/Kolkata');
  const now = wallClockToUtc({ year: 2026, month: 9, day: 7, hour: 10, minute: 0 }, 'Asia/Kolkata');
  const startAt = clampSeriesStartAt(requested, created, 'Asia/Kolkata');
  const s = series({
    startAt,
    createdAt: created,
    recurrence: { frequency: 'daily', interval: 1 },
    end: { mode: 'afterCount', count: 7 },
  });
  const floor = seriesMaterializationFloor(s, now);
  const occ = generateOccurrences(s, horizon).filter((o) => o.at.getTime() >= floor.getTime());
  assert.equal(wallClockPartsInZone(occ[0].at, 'Asia/Kolkata').day, 7);
  assert.equal(occ.length, 7);
});

test('daily afterCount from clamped start does not backfill before creation day', () => {
  const requested = wallClockToUtc({ year: 2026, month: 9, day: 3, hour: 12, minute: 15 }, 'Asia/Kolkata');
  const created = wallClockToUtc({ year: 2026, month: 9, day: 9, hour: 10, minute: 0 }, 'Asia/Kolkata');
  const startAt = clampSeriesStartAt(requested, created, 'Asia/Kolkata');
  const s = series({
    startAt,
    recurrence: { frequency: 'daily', interval: 1 },
    end: { mode: 'afterCount', count: 7 },
  });
  const occ = generateOccurrences(s, horizon);
  assert.equal(occ.length, 7);
  assert.equal(wallClockPartsInZone(occ[0].at, 'Asia/Kolkata').day, 9);
  assert.equal(wallClockPartsInZone(occ[6].at, 'Asia/Kolkata').day, 15);
});

test('recurrenceLabel maps frequencies to display labels', () => {
  assert.equal(recurrenceLabel({ frequency: 'daily' }), 'Daily');
  assert.equal(recurrenceLabel({ frequency: 'weekly' }), 'Weekly');
  assert.equal(recurrenceLabel({ frequency: 'monthly' }), 'Monthly');
  assert.equal(recurrenceLabel({ frequency: 'custom' }), 'Custom');
  assert.equal(recurrenceLabel(null), '');
});
