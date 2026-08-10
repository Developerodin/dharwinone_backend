import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvgDailyPresent,
  enrichAttendanceSummary,
  leaveDatesWindowClause,
  backdatedEntriesWindowClause,
  looksLikeWeekOffOrGroupsQuery,
  looksLikeOnLeaveTodayQuery,
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
    assert.deepEqual(clause, { dates: { $elemMatch: { $gte: from, $lte: to } } });
    assert.equal(leaveDatesWindowClause(null), null);
  });

  it('binds both bounds to the same leave day (no cross-element match)', () => {
    // Single-day window in the middle of a long leave run. A bare
    // { dates: { $gte, $lte } } matched this because 2026-08-31 >= from and
    // 2026-07-23 <= to — two DIFFERENT elements. $elemMatch must not.
    const day = new Date(Date.UTC(2026, 7, 6));
    const dayEnd = new Date(Date.UTC(2026, 7, 6, 23, 59, 59, 999));
    const { $elemMatch } = leaveDatesWindowClause({ from: day, to: dayEnd }).dates;

    const matchesDay = (dates) =>
      dates.some((d) => d >= $elemMatch.$gte && d <= $elemMatch.$lte);

    const spansButSkipsTheDay = [
      new Date(Date.UTC(2026, 6, 23)),
      new Date(Date.UTC(2026, 7, 31)),
    ];
    const bookedOnTheDay = [
      new Date(Date.UTC(2026, 7, 5)),
      new Date(Date.UTC(2026, 7, 6)),
    ];
    assert.equal(matchesDay(spansButSkipsTheDay), false);
    assert.equal(matchesDay(bookedOnTheDay), true);
  });

  it('keeps open-ended windows one-sided', () => {
    const from = new Date(Date.UTC(2026, 7, 1));
    assert.deepEqual(leaveDatesWindowClause({ from, to: null }), {
      dates: { $elemMatch: { $gte: from } },
    });
    const to = new Date(Date.UTC(2026, 7, 31, 23, 59, 59, 999));
    assert.deepEqual(leaveDatesWindowClause({ from: null, to }), {
      dates: { $elemMatch: { $lte: to } },
    });
  });

  it('matches boundary days at both ends of a month window', () => {
    const from = new Date(Date.UTC(2026, 7, 1));
    const to = new Date(Date.UTC(2026, 7, 31, 23, 59, 59, 999));
    const { $elemMatch } = leaveDatesWindowClause({ from, to }).dates;
    const inWindow = (d) => d >= $elemMatch.$gte && d <= $elemMatch.$lte;

    assert.equal(inWindow(new Date(Date.UTC(2026, 7, 1))), true);   // first day
    assert.equal(inWindow(new Date(Date.UTC(2026, 7, 31))), true);  // last day
    assert.equal(inWindow(new Date(Date.UTC(2026, 6, 31))), false); // day before
    assert.equal(inWindow(new Date(Date.UTC(2026, 8, 1))), false);  // day after
  });

  it('builds backdated window on attendanceEntries.date', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const clause = backdatedEntriesWindowClause({ from, to });
    assert.deepEqual(clause, { 'attendanceEntries.date': { $gte: from, $lte: to } });
  });

  it('detects on-leave-today asks (needs both a leave subject and a now-anchor)', () => {
    for (const q of [
      'who is on leave today',
      'who is off today',
      'is anyone absent right now',
      "today's leaves",
      'anyone out of office currently',
    ]) {
      assert.equal(looksLikeOnLeaveTodayQuery(q), true, q);
    }
  });

  it('leaves non-today and non-leave asks to other routes', () => {
    for (const q of [
      'pending leaves',            // no now-anchor
      'who joined today',          // now-anchor but not about leave
      'how many leaves last month',
      '',
    ]) {
      assert.equal(looksLikeOnLeaveTodayQuery(q), false, q);
    }
    assert.equal(looksLikeOnLeaveTodayQuery(null), false);
  });

  it('yields a today-scoped ranking ask to the ranking route', () => {
    // "most" makes it a comparison; leaveRanking owns it even though it says today.
    assert.equal(looksLikeOnLeaveTodayQuery('who has the most leaves today'), false);
  });

  it('routes week-off / groups asks to overview (not org attendance sum)', () => {
    assert.equal(looksLikeWeekOffOrGroupsQuery("what is Saad's week off?"), true);
    assert.equal(looksLikeWeekOffOrGroupsQuery('which candidate groups is DBS10 in?'), true);
    assert.equal(looksLikeWeekOffOrGroupsQuery('how many were present yesterday'), false);
  });
});
