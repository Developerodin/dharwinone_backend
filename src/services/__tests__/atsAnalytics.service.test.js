import test from 'node:test';
import assert from 'node:assert/strict';
import { getDateRange, createdAtMatch, RANGE_DAYS } from '../atsAnalytics.service.js';

test('RANGE_DAYS covers all supported analytics periods', () => {
  assert.deepEqual(Object.keys(RANGE_DAYS).sort(), ['12m', '30d', '3m', '7d']);
});

test('getDateRange returns null for all-time / unknown ranges', () => {
  assert.equal(getDateRange(undefined), null);
  assert.equal(getDateRange(''), null);
  assert.equal(getDateRange('all'), null);
});

test('getDateRange builds contiguous current and previous windows', () => {
  const now = Date.now();
  const range = getDateRange('7d');
  assert.ok(range);
  assert.equal(range.days, 7);

  const spanMs = range.end.getTime() - range.start.getTime();
  assert.ok(spanMs >= 6.9 * 86400000 && spanMs <= 7.1 * 86400000);
  assert.ok(Math.abs(range.end.getTime() - now) < 5000);

  const prevSpanMs = range.previousEnd.getTime() - range.previousStart.getTime();
  assert.ok(prevSpanMs >= 6.9 * 86400000 && prevSpanMs <= 7.1 * 86400000);
  assert.ok(range.previousEnd < range.start);
  assert.ok(range.start.getTime() - range.previousEnd.getTime() <= 1000);
});

test('createdAtMatch is empty without a range and bounded with one', () => {
  assert.deepEqual(createdAtMatch(null), {});
  const range = getDateRange('30d');
  const match = createdAtMatch(range);
  assert.ok(match.createdAt.$gte instanceof Date);
  assert.ok(match.createdAt.$lte instanceof Date);
  assert.equal(match.createdAt.$gte.getTime(), range.start.getTime());
  assert.equal(match.createdAt.$lte.getTime(), range.end.getTime());
});
