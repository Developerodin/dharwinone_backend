import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COURSE_PROGRESS_STATUSES,
  buildCourseProgressFilter,
  summarizeCourseProgressBreakdown,
} from '../trainingAnalytics.js';

describe('trainingAnalytics (Epic F — Student population only)', () => {
  it('documents the confirmed status vocabulary', () => {
    assert.deepEqual(COURSE_PROGRESS_STATUSES, ['enrolled', 'in-progress', 'completed', 'dropped']);
  });

  it('builds an empty filter when no student id is given', () => {
    assert.deepEqual(buildCourseProgressFilter(), {});
    assert.deepEqual(buildCourseProgressFilter(null), {});
  });

  it('scopes to a single Student._id', () => {
    assert.deepEqual(buildCourseProgressFilter('s1'), { student: 's1' });
  });

  it('scopes to multiple Student._id values via $in', () => {
    assert.deepEqual(buildCourseProgressFilter(['s1', 's2']), { student: { $in: ['s1', 's2'] } });
  });

  it('drops empty arrays instead of emitting student: { $in: [] }', () => {
    assert.deepEqual(buildCourseProgressFilter([]), {});
  });

  it('filters by a valid status and drops invalid ones', () => {
    assert.deepEqual(buildCourseProgressFilter('s1', { status: 'completed' }), {
      student: 's1',
      status: 'completed',
    });
    assert.deepEqual(buildCourseProgressFilter('s1', { status: 'bogus' }), { student: 's1' });
  });

  it('filters by module and enrolledAt window', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    assert.deepEqual(buildCourseProgressFilter('s1', { module: 'm1', from, to }), {
      student: 's1',
      module: 'm1',
      enrolledAt: { $gte: from, $lte: to },
    });
  });

  it('summarizes status rows into zero-filled canonical buckets', () => {
    const summary = summarizeCourseProgressBreakdown([
      { _id: 'completed', count: 4 },
      { _id: 'enrolled', count: 2 },
    ]);
    assert.deepEqual(summary.byStatus, { enrolled: 2, 'in-progress': 0, completed: 4, dropped: 0 });
    assert.equal(summary.total, 6);
  });

  it('handles an empty aggregation array without throwing', () => {
    const summary = summarizeCourseProgressBreakdown();
    assert.deepEqual(summary.byStatus, { enrolled: 0, 'in-progress': 0, completed: 0, dropped: 0 });
    assert.equal(summary.total, 0);
  });
});
