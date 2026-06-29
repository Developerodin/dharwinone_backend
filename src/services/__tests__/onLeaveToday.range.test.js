import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contiguousRange } from '../onLeaveToday.service.js';

const DAY = 86400000;
const TODAY = Date.UTC(2026, 5, 29); // 2026-06-29

test('single day = today only', () => {
  const { startMs, endMs } = contiguousRange([TODAY], TODAY);
  assert.equal(startMs, TODAY);
  assert.equal(endMs, TODAY);
});

test('today implicitly included even if absent from list', () => {
  const { startMs, endMs } = contiguousRange([], TODAY);
  assert.equal(startMs, TODAY);
  assert.equal(endMs, TODAY);
});

test('walks both directions over a contiguous block', () => {
  const days = [TODAY - 2 * DAY, TODAY - DAY, TODAY, TODAY + DAY];
  const { startMs, endMs } = contiguousRange(days, TODAY);
  assert.equal(startMs, TODAY - 2 * DAY);
  assert.equal(endMs, TODAY + DAY);
});

test('a gap stops the run', () => {
  const days = [TODAY - 3 * DAY, TODAY, TODAY + DAY]; // gap before today
  const { startMs, endMs } = contiguousRange(days, TODAY);
  assert.equal(startMs, TODAY);
  assert.equal(endMs, TODAY + DAY);
});

test('unordered + duplicate days handled', () => {
  const days = [TODAY + DAY, TODAY, TODAY, TODAY - DAY, TODAY + DAY];
  const { startMs, endMs } = contiguousRange(days, TODAY);
  assert.equal(startMs, TODAY - DAY);
  assert.equal(endMs, TODAY + DAY);
});
