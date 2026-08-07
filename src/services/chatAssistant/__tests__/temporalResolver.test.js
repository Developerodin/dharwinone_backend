import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mostRecentYearForMonth,
  yearFromMemory,
  resolveTemporalWindow,
  buildMultiYearClarification,
} from '../temporalResolver.js';

const AUG_2026 = new Date(Date.UTC(2026, 7, 7));
const JAN_2026 = new Date(Date.UTC(2026, 0, 15));

describe('temporalResolver helpers', () => {
  it('mostRecentYearForMonth: Aug 2026 + July → 2026; Jan 2026 + December → 2025', () => {
    assert.equal(mostRecentYearForMonth(7, AUG_2026), 2026);
    assert.equal(mostRecentYearForMonth(12, JAN_2026), 2025);
    assert.equal(mostRecentYearForMonth(8, AUG_2026), 2026);
    assert.equal(mostRecentYearForMonth(9, AUG_2026), 2025);
  });

  it('yearFromMemory reads year from lastFromDate / label', () => {
    assert.equal(yearFromMemory({ lastFromDate: '2026-01-01', lastToDate: '2026-12-31' }), 2026);
    assert.equal(yearFromMemory({ lastDateLabel: 'during 2025-07' }), 2025);
    assert.equal(yearFromMemory(null), null);
  });
});

describe('resolveTemporalWindow', () => {
  it('calendar-only: Aug 2026 + july → 2026-07, no clarify', async () => {
    const r = await resolveTemporalWindow({
      text: 'employees resigned in july',
      now: AUG_2026,
    });
    assert.equal(r.needsClarification, undefined);
    assert.equal(r.month, '2026-07');
  });

  it('calendar-only: Jan 2026 + december → 2025-12', async () => {
    const r = await resolveTemporalWindow({
      text: 'joined in december',
      now: JAN_2026,
    });
    assert.equal(r.month, '2025-12');
  });

  it('multi-year resign data → needsClarification with counts, most recent first', async () => {
    const r = await resolveTemporalWindow({
      text: 'employees resigned in july',
      now: AUG_2026,
      dateField: 'resignDate',
      eventLabel: 'resignation',
      probeYears: async () => [
        { year: 2026, count: 5 },
        { year: 2025, count: 6 },
      ],
    });
    assert.equal(r.needsClarification, true);
    assert.match(r.clarifyingQuestion, /multiple Julys/i);
    assert.match(r.clarifyingQuestion, /July 2026 \(5\)/);
    assert.match(r.clarifyingQuestion, /July 2025 \(6\)/);
    assert.doesNotMatch(r.clarifyingQuestion, /^Which year\?/i);
    assert.ok(Array.isArray(r.options));
    assert.equal(r.options[0].year, 2026);
    assert.equal(r.options[1].year, 2025);
  });

  it('single year with data → that year even if not calendar most-recent', async () => {
    const r = await resolveTemporalWindow({
      text: 'employees resigned in july',
      now: AUG_2026,
      dateField: 'resignDate',
      eventLabel: 'resignation',
      probeYears: async () => [{ year: 2023, count: 4 }],
    });
    assert.equal(r.needsClarification, undefined);
    assert.equal(r.month, '2023-07');
  });

  it('zero years with data → calendar most-recent (empty result OK)', async () => {
    const r = await resolveTemporalWindow({
      text: 'employees resigned in july',
      now: AUG_2026,
      dateField: 'resignDate',
      probeYears: async () => [],
    });
    assert.equal(r.needsClarification, undefined);
    assert.equal(r.month, '2026-07');
  });

  it('memory: prior year 2026 + only july → 2026-07 without re-asking', async () => {
    const r = await resolveTemporalWindow({
      text: 'only july',
      now: AUG_2026,
      memory: { lastFromDate: '2026-01-01', lastToDate: '2026-12-31', lastDateLabel: '2026' },
      dateField: 'resignDate',
      // Even if multi-year data exists, memory year wins — no re-ask.
      probeYears: async () => [
        { year: 2026, count: 5 },
        { year: 2025, count: 6 },
      ],
    });
    assert.equal(r.needsClarification, undefined);
    assert.equal(r.month, '2026-07');
  });

  it('buildMultiYearClarification prefers natural copy with counts', () => {
    const q = buildMultiYearClarification({
      monthName: 'July',
      eventLabel: 'resignation',
      years: [
        { year: 2026, count: 5 },
        { year: 2025, count: 6 },
      ],
    });
    assert.match(q, /resignation records in multiple Julys/i);
    assert.match(q, /July 2026 \(5\)/);
    assert.match(q, /July 2025 \(6\)/);
  });
});
