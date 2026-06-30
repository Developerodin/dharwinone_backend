import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanFromDates } from '../onLeaveToday.service.js';

const DAY = 86400000;
const TODAY = Date.UTC(2026, 5, 30); // 2026-06-30 (Tue)

test('empty list = fallback (today) only', () => {
  const { startMs, endMs } = spanFromDates([], TODAY);
  assert.equal(startMs, TODAY);
  assert.equal(endMs, TODAY);
});

test('single date', () => {
  const d = Date.UTC(2026, 5, 30);
  const { startMs, endMs } = spanFromDates([new Date(d)], TODAY);
  assert.equal(startMs, d);
  assert.equal(endMs, d);
});

test('min..max regardless of order or time component', () => {
  const dates = [
    new Date(Date.UTC(2026, 6, 8, 9, 30)), // Jul 8, with a stray time → normalized to midnight
    new Date(Date.UTC(2026, 5, 1)), // Jun 1
    new Date(Date.UTC(2026, 5, 15)), // Jun 15
  ];
  const { startMs, endMs } = spanFromDates(dates, TODAY);
  assert.equal(startMs, Date.UTC(2026, 5, 1));
  assert.equal(endMs, Date.UTC(2026, 6, 8));
});

// Regression: weekday-only leave that skips weekends. The old contiguous-day walk
// stopped at the first weekend gap (reported only ~Jun 29–Jul 3). The span must be
// the full request range, ignoring the gaps.
test('weekday-only span spanning weekends returns full min..max', () => {
  const weekdays = [];
  // Jun 1 (Mon) .. Jul 8 (Wed) 2026, weekdays only
  for (let d = Date.UTC(2026, 5, 1); d <= Date.UTC(2026, 6, 8); d += DAY) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays.push(new Date(d));
  }
  const { startMs, endMs } = spanFromDates(weekdays, TODAY);
  assert.equal(startMs, Date.UTC(2026, 5, 1)); // Jun 1, not Jun 29
  assert.equal(endMs, Date.UTC(2026, 6, 8)); // Jul 8, not Jul 3
});
