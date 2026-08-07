import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvgDailyPresent,
  enrichAttendanceSummary,
  leaveDatesWindowClause,
  backdatedEntriesWindowClause,
  looksLikeWeekOffOrGroupsQuery,
} from '../attendanceAnalytics.js';

describe('attendanceAnalytics (Epic B)', () => {
  it('averages Present across perDay without requiring LLM summation', () => {
    const perDay = [
      { date: '2026-07-01', counts: { Present: 10 } },
      { date: '2026-07-02', counts: { Present: 14 } },
      { date: '2026-07-03', counts: { Present: 12 } },
    ];
    const stats = computeAvgDailyPresent(perDay, {
      excludeFuture: false,
      todayIso: '2026-07-31',
    });
    assert.equal(stats.totalPresent, 36);
    assert.equal(stats.dayCount, 3);
    assert.equal(stats.avgDailyPresent, 12);
  });

  it('excludes future calendar days from the average by default', () => {
    const perDay = [
      { date: '2026-07-01', counts: { Present: 10 } },
      { date: '2026-07-15', counts: { Present: 0 } }, // future relative to todayIso
    ];
    const stats = computeAvgDailyPresent(perDay, { todayIso: '2026-07-10' });
    assert.equal(stats.dayCount, 1);
    assert.equal(stats.avgDailyPresent, 10);
  });

  it('enriches attendance summary with authoritative avgDailyPresent', () => {
    const enriched = enrichAttendanceSummary(
      {
        total: 20,
        perDay: [
          { date: '2026-07-01', counts: { Present: 8 } },
          { date: '2026-07-02', counts: { Present: 12 } },
        ],
      },
      { todayIso: '2026-07-31' }
    );
    assert.equal(enriched.avgDailyPresent, 10);
    assert.equal(enriched.authoritative, true);
  });

  it('builds leave dates window on LeaveRequest.dates array', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const clause = leaveDatesWindowClause({ from, to });
    assert.deepEqual(clause, { dates: { $gte: from, $lte: to } });
    assert.equal(leaveDatesWindowClause(null), null);
  });

  it('builds backdated window on attendanceEntries.date', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const clause = backdatedEntriesWindowClause({ from, to });
    assert.deepEqual(clause, { 'attendanceEntries.date': { $gte: from, $lte: to } });
  });

  it('routes week-off / groups asks to overview (not org attendance sum)', () => {
    assert.equal(looksLikeWeekOffOrGroupsQuery("what is Saad's week off?"), true);
    assert.equal(looksLikeWeekOffOrGroupsQuery('which candidate groups is DBS10 in?'), true);
    assert.equal(looksLikeWeekOffOrGroupsQuery('how many were present yesterday'), false);
  });
});
