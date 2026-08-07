import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInternalMeetingFilter,
  summarizeInternalMeetingStatusRows,
} from '../meetingAnalytics.js';

describe('meetingAnalytics (Epic E — internal/non-interview meetings)', () => {
  it('builds an empty filter when no args are passed', () => {
    assert.deepEqual(buildInternalMeetingFilter(), {});
  });

  it('windows on scheduledAt, inclusive', () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const filter = buildInternalMeetingFilter({ from, to });
    assert.deepEqual(filter, { scheduledAt: { $gte: from, $lte: to } });
  });

  it('matches participant by email across hosts.email and emailInvites', () => {
    const filter = buildInternalMeetingFilter({ participantEmail: 'a@x.com' });
    assert.deepEqual(filter, {
      $or: [{ 'hosts.email': 'a@x.com' }, { emailInvites: 'a@x.com' }],
    });
  });

  it('matches participant by name on hosts.nameOrRole', () => {
    const filter = buildInternalMeetingFilter({ participantName: 'Saad' });
    assert.deepEqual(filter, {
      $or: [{ 'hosts.nameOrRole': { $regex: 'Saad', $options: 'i' } }],
    });
  });

  it('combines email + name participant clauses under one $or', () => {
    const filter = buildInternalMeetingFilter({ participantEmail: 'a@x.com', participantName: 'Saad' });
    assert.deepEqual(filter.$or, [
      { 'hosts.email': 'a@x.com' },
      { emailInvites: 'a@x.com' },
      { 'hosts.nameOrRole': { $regex: 'Saad', $options: 'i' } },
    ]);
  });

  it('filters by status and meetingType when valid', () => {
    const filter = buildInternalMeetingFilter({ status: 'ended', meetingType: 'Video' });
    assert.deepEqual(filter, { status: 'ended', meetingType: 'Video' });
  });

  it('drops invalid status / meetingType values', () => {
    const filter = buildInternalMeetingFilter({ status: 'bogus', meetingType: 'Fax' });
    assert.deepEqual(filter, {});
  });

  it('scopes createdBy to a single id or a list (company scoping)', () => {
    assert.deepEqual(buildInternalMeetingFilter({ createdBy: 'u1' }), { createdBy: 'u1' });
    assert.deepEqual(buildInternalMeetingFilter({ createdBy: ['u1', 'u2'] }), {
      createdBy: { $in: ['u1', 'u2'] },
    });
  });

  it('zero-fills status rows into the canonical scheduled/ended/cancelled buckets', () => {
    const summary = summarizeInternalMeetingStatusRows([{ _id: 'scheduled', count: 4 }]);
    assert.deepEqual(summary, { scheduled: 4, ended: 0, cancelled: 0 });
  });

  it('handles an empty aggregation array without throwing', () => {
    assert.deepEqual(summarizeInternalMeetingStatusRows(), { scheduled: 0, ended: 0, cancelled: 0 });
  });
});
