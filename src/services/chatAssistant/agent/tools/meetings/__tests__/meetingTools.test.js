import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countMeetings from '../countMeetings.tool.js';
import listMeetings from '../listMeetings.tool.js';

const VIEWER = { id: 'v1', _id: 'v1' };
const NOW = new Date('2026-09-29T10:00:00.000Z');

function ctxWith(queryInternalMeetings) {
  return { user: VIEWER, requestId: 'r', deps: { queryInternalMeetings, now: () => NOW } };
}

const flat = (filter) => JSON.stringify(filter);

describe('count_meetings', () => {
  it('passes the viewer to queryInternalMeetings and returns total + status breakdown, no rows', async () => {
    const calls = [];
    const out = await countMeetings.execute({ filters: {} }, ctxWith(async (filter, options, user, scope) => {
      calls.push({ filter, options, user, scope });
      const status = flat(filter).match(/"status":"(\w+)"/)?.[1];
      return { totalResults: { scheduled: 4, ended: 7, cancelled: 1 }[status] ?? 12, results: [{}] };
    }));
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.user === VIEWER && c.options.limit === 1));
    assert.deepEqual(out.breakdown, { scheduled: 4, ended: 7, cancelled: 1 });
    assert.equal(out.total, 12);
    assert.equal('records' in out, false);
  });

  it('covers past meetings too (B8): "past" bounds scheduledAt below now, not status scheduled only', async () => {
    let first;
    await countMeetings.execute({ filters: { when: 'past' } }, ctxWith(async (filter) => {
      first = first || filter;
      return { totalResults: 0, results: [] };
    }));
    assert.deepEqual(first, { $and: [{ scheduledAt: { $lt: NOW } }] });
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(countMeetings.execute({}, { deps: { queryInternalMeetings: async () => ({}) } }), /user with an id/);
  });
});

describe('list_meetings', () => {
  it('maps rows to page-visible fields only: no description, no invite emails', async () => {
    let seen;
    const out = await listMeetings.execute(
      { filters: { when: 'upcoming', status: 'scheduled', mine: true }, limit: 5 },
      ctxWith(async (filter, options, user, scope) => {
        seen = { filter, options, scope };
        return {
          totalResults: 9,
          results: [{
            id: 'm1', title: 'Sprint sync', description: 'secret agenda', scheduledAt: NOW, timezone: 'UTC',
            durationMinutes: 30, meetingType: 'Video', status: 'scheduled',
            hosts: [{ nameOrRole: 'Asha', email: 'asha@x.com' }], emailInvites: ['a@x.com', 'b@x.com'],
            createdBy: { name: 'Asha' },
          }],
        };
      }),
    );
    assert.equal(seen.options.sortBy, 'scheduledAt');
    assert.equal(seen.options.limit, 5);
    assert.deepEqual(seen.scope, { listScope: 'mine' });
    assert.deepEqual(seen.filter, { $and: [{ scheduledAt: { $gte: NOW } }, { status: 'scheduled' }] });
    assert.equal(out.total, 9);
    assert.deepEqual(out.records[0], {
      id: 'm1', title: 'Sprint sync', scheduledAt: NOW, timezone: 'UTC', durationMinutes: 30, meetingType: 'Video',
      status: 'scheduled', hosts: ['Asha'], invitedCount: 2, createdBy: 'Asha',
    });
  });

  it('turns scheduledBetween into whole IST days and keeps the page search clause', async () => {
    let seen;
    await listMeetings.execute(
      { filters: { search: 'onboarding', scheduledBetween: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxWith(async (filter, options) => { seen = { filter, options }; return { totalResults: 0, results: [] }; }),
    );
    assert.equal(seen.options.sortBy, '-scheduledAt');
    const [search, window] = seen.filter.$and;
    assert.ok(search.$or.some((c) => c.title));
    assert.deepEqual(window, {
      scheduledAt: { $gte: new Date('2026-08-31T18:30:00.000Z'), $lte: new Date('2026-09-30T18:29:59.999Z') },
    });
  });

  it('rejects a malformed day', async () => {
    await assert.rejects(
      listMeetings.execute({ filters: { scheduledBetween: { from: '2026/09/01' } } }, ctxWith(async () => ({}))),
      /YYYY-MM-DD/,
    );
  });
});
