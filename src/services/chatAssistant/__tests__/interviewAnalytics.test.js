import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInterviewFilter,
  summarizeInterviewBreakdown,
} from '../interviewAnalytics.js';

describe('interviewAnalytics (Epic D)', () => {
  it('builds an empty filter when no args are passed', () => {
    assert.deepEqual(buildInterviewFilter(), {});
    assert.deepEqual(buildInterviewFilter({}), {});
  });

  it('prefers scheduledAt for the date window by default', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const filter = buildInterviewFilter({ from, to });
    assert.deepEqual(filter, { scheduledAt: { $gte: from, $lte: to } });
  });

  it('can opt into createdAt as the date field', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const filter = buildInterviewFilter({ from, dateField: 'createdAt' });
    assert.deepEqual(filter, { createdAt: { $gte: from } });
  });

  it('matches interviewer name on recruiter.name OR agents.name — never candidate', () => {
    const filter = buildInterviewFilter({ interviewerName: 'Saad' });
    assert.deepEqual(filter, {
      $or: [
        { 'recruiter.name': { $regex: 'Saad', $options: 'i' } },
        { 'agents.name': { $regex: 'Saad', $options: 'i' } },
      ],
    });
  });

  it('matches candidate name on candidate.name — a separate filter from interviewer', () => {
    const filter = buildInterviewFilter({ candidateName: 'Priya' });
    assert.deepEqual(filter, {
      'candidate.name': { $regex: 'Priya', $options: 'i' },
    });
  });

  it('combines interviewer + candidate + status + interviewResult filters together', () => {
    const filter = buildInterviewFilter({
      interviewerName: 'Saad',
      candidateName: 'Priya',
      status: 'ended',
      interviewResult: 'selected',
    });
    assert.deepEqual(filter, {
      $or: [
        { 'recruiter.name': { $regex: 'Saad', $options: 'i' } },
        { 'agents.name': { $regex: 'Saad', $options: 'i' } },
      ],
      'candidate.name': { $regex: 'Priya', $options: 'i' },
      status: 'ended',
      interviewResult: 'selected',
    });
  });

  it('ignores unknown status / interviewResult values instead of passing them through', () => {
    const filter = buildInterviewFilter({ status: 'bogus', interviewResult: 'nope' });
    assert.deepEqual(filter, {});
  });

  it('escapes regex-special characters in name filters', () => {
    const filter = buildInterviewFilter({ interviewerName: 'A.B+C' });
    assert.equal(filter.$or[0]['recruiter.name'].$regex, 'A\\.B\\+C');
  });

  it('scopes by tenantId / createdBy when provided', () => {
    const filter = buildInterviewFilter({ tenantId: 't1', createdBy: 'u1' });
    assert.deepEqual(filter, { tenantId: 't1', createdBy: 'u1' });
  });

  it('summarizes status + result aggregation rows with zero-filled buckets', () => {
    const statusAgg = [{ _id: 'scheduled', count: 5 }, { _id: 'ended', count: 3 }];
    const resultAgg = [{ _id: 'pending', count: 5 }, { _id: 'selected', count: 2 }, { _id: 'rejected', count: 1 }];
    const summary = summarizeInterviewBreakdown(statusAgg, resultAgg);
    assert.deepEqual(summary.byStatus, { scheduled: 5, ended: 3, cancelled: 0 });
    assert.deepEqual(summary.byResult, { pending: 5, selected: 2, rejected: 1 });
    assert.equal(summary.total, 8);
  });

  it('handles empty aggregation arrays without throwing', () => {
    const summary = summarizeInterviewBreakdown();
    assert.deepEqual(summary.byStatus, { scheduled: 0, ended: 0, cancelled: 0 });
    assert.deepEqual(summary.byResult, { pending: 0, selected: 0, rejected: 0 });
    assert.equal(summary.total, 0);
  });
});
