import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countMeetings from '../countMeetings.tool.js';
import listMeetings from '../listMeetings.tool.js';
import getMeeting from '../getMeeting.tool.js';
import meetingsDomain from '../index.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const VIEWER = { id: 'v1', _id: 'v1' };
const NOW = new Date('2026-09-29T10:00:00.000Z');
const allow = async () => ({ ok: true });
const deny = async () => ({ ok: false });

function ctxWith(queryInternalMeetings, extra = {}) {
  return { user: VIEWER, requestId: 'r', deps: { queryInternalMeetings, now: () => NOW, checkAccess: deny, ...extra } };
}

const flat = (filter) => JSON.stringify(filter);

describe('meetings domain', () => {
  it('exports a one-line summary and all three tools', () => {
    assert.ok(meetingsDomain.summary.length <= 120 && !/\n/.test(meetingsDomain.summary));
    assert.deepEqual(meetingsDomain.tools.map((t) => t.name), ['count_meetings', 'list_meetings', 'get_meeting']);
  });
});

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
  const ROW = {
    id: 'm1', meetingId: 'room-1', title: 'Sprint sync', description: 'secret agenda', scheduledAt: NOW, timezone: 'UTC',
    durationMinutes: 30, meetingType: 'Video', status: 'scheduled',
    hosts: [{ nameOrRole: 'Asha', email: 'asha@x.com' }], emailInvites: ['a@x.com', 'b@x.com'],
    createdBy: { name: 'Asha' },
  };

  it('maps rows to page-visible fields only: no description, no invite emails', async () => {
    let seen;
    const out = await listMeetings.execute(
      { filters: { when: 'upcoming', status: 'scheduled', mine: true }, limit: 5 },
      ctxWith(async (filter, options, user, scope) => {
        seen = { filter, options, scope };
        return { totalResults: 9, results: [ROW] };
      }),
    );
    assert.equal(seen.options.sortBy, 'scheduledAt');
    assert.equal(seen.options.limit, 5);
    assert.deepEqual(seen.scope, { listScope: 'mine' });
    assert.deepEqual(seen.filter, { $and: [{ scheduledAt: { $gte: NOW } }, { status: 'scheduled' }] });
    assert.equal(out.total, 9);
    assert.deepEqual(out.records[0], {
      id: 'm1', title: 'Sprint sync', scheduledAt: NOW, timezone: 'UTC', durationMinutes: 30, meetingType: 'Video',
      status: 'scheduled', hosts: ['Asha'], invitedCount: 2, createdBy: 'Asha', hasRecording: null,
    });
  });

  it('defaults to 20 rows', async () => {
    let seen;
    await listMeetings.execute({}, ctxWith(async (f, options) => { seen = options; return { totalResults: 0, results: [] }; }));
    assert.equal(seen.limit, 20);
  });

  it('hasRecording: ONE batched Recording lookup by room id (completed = playable), not a call per row', async () => {
    const asked = [];
    const out = await listMeetings.execute({ filters: { status: 'ended' } }, ctxWith(
      async () => ({ totalResults: 3, results: [ROW, { ...ROW, id: 'm2', meetingId: 'room-2' }, { ...ROW, id: 'm3', meetingId: undefined }] }),
      {
        checkAccess: allow,
        listRecordings: async () => { throw new Error('per-row lookup must not run'); },
        playableRecordingRooms: async (rooms) => { asked.push(rooms); return ['room-1']; },
      },
    ));
    assert.deepEqual(asked, [['room-1', 'room-2']]);
    assert.deepEqual(out.records.map((r) => r.hasRecording), [true, false, null]);
    assert.ok(!JSON.stringify(out.records).includes('room-'), 'room ids stay internal');
  });

  it('a failed recording lookup degrades to hasRecording null + a note, never a guess', async () => {
    const out = await listMeetings.execute({}, ctxWith(
      async () => ({ totalResults: 1, results: [ROW] }),
      { checkAccess: allow, playableRecordingRooms: async () => { throw new Error('db down'); } },
    ));
    assert.equal(out.records[0].hasRecording, null);
    assert.match(out.recordingNote, /lookup failed/);
  });

  it('never looks up recordings without the recordings permission: hasRecording null + a note', async () => {
    let looked = false;
    const out = await listMeetings.execute({}, ctxWith(
      async () => ({ totalResults: 1, results: [ROW] }),
      { playableRecordingRooms: async () => { looked = true; return []; } },
    ));
    assert.equal(looked, false);
    assert.equal(out.records[0].hasRecording, null);
    assert.match(out.recordingNote, /meetings\.read/);
  });

  it('earlier_today bounds scheduledAt from IST midnight today up to now', async () => {
    let seen;
    await listMeetings.execute({ filters: { when: 'earlier_today' } }, ctxWith(async (filter) => {
      seen = filter;
      return { totalResults: 0, results: [] };
    }));
    assert.deepEqual(seen, { $and: [{ scheduledAt: { $gte: new Date('2026-09-28T18:30:00.000Z'), $lt: NOW } }] });
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

describe('get_meeting', () => {
  const MEETING = {
    id: 'm1', meetingId: 'room-1', title: 'Design review', scheduledAt: NOW, status: 'ended', endedAt: NOW,
    hosts: [{ nameOrRole: 'Asha', email: 'asha@x.com' }], emailInvites: ['b@x.com'], description: 'secret',
    participantRoster: [{
      identity: 'u-9', displayName: 'Ravi', role: 'host', emailHash: 'h', firstJoinedAt: NOW, lastJoinedAt: NOW,
    }],
  };
  const SUMMARY = {
    executiveSummary: 'Agreed on v2 layout.', partial: false, generatedAt: NOW, llmCostUsd: 0.2,
    decisions: [{ text: 'Ship v2', timestampMs: 5 }],
    actionItems: [{ text: 'Update Figma', owner: 'Ravi', dueHint: 'Friday', timestampMs: 9 }],
  };

  function detailCtx(extra = {}) {
    return {
      user: VIEWER,
      deps: {
        now: () => NOW,
        getInternalMeetingById: async () => MEETING,
        queryInternalMeetings: async () => ({ totalResults: 0, results: [] }),
        listRecordings: async () => [
          { status: 'completed', playbackUrl: 'https://s3/signed' }, { status: 'failed' },
        ],
        findSummary: async () => SUMMARY,
        ...extra,
      },
    };
  }

  it('is gated on the meeting detail route permission (meetings.read or onboarding.edit)', async () => {
    assert.deepEqual(getMeeting.access.anyOf, ['meetings.read', 'onboarding.edit']);
    const noPerms = { id: 'x', authContext: { permissions: new Set() } };
    assert.equal((await checkAccessRule(getMeeting.access, noPerms)).ok, false);
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(getMeeting.execute({ id: 'm1' }, { deps: detailCtx().deps }), /user with an id/);
  });

  it('by id: passes the viewer for row scope; returns attendees, recording and summary without private fields', async () => {
    const seen = {};
    const out = await getMeeting.execute({ id: 'm1' }, detailCtx({
      getInternalMeetingById: async (id, user) => { seen.byId = { id, user }; return MEETING; },
      listRecordings: async (id) => { seen.recordingsFor = id; return [{ status: 'completed', playbackUrl: 'https://s3/signed' }]; },
      findSummary: async (meetingId) => { seen.summaryFor = meetingId; return SUMMARY; },
    }));
    assert.deepEqual(seen, { byId: { id: 'm1', user: VIEWER }, recordingsFor: 'm1', summaryFor: 'room-1' });
    assert.equal(out.found, true);
    const m = out.meeting;
    assert.deepEqual(m.attendees, [{ name: 'Ravi', role: 'host', firstJoinedAt: NOW, lastJoinedAt: NOW }]);
    assert.equal(m.recorded, true);
    assert.equal(m.recordingLink, 'https://s3/signed');
    assert.deepEqual(m.summary.decisions, ['Ship v2']);
    assert.deepEqual(m.summary.actionItems, [{ text: 'Update Figma', owner: 'Ravi', due: 'Friday' }]);
    const json = JSON.stringify(out);
    for (const leaked of ['secret', 'emailHash', 'u-9', 'b@x.com', 'llmCostUsd']) assert.ok(!json.includes(leaked), leaked);
  });

  it('a meeting outside the viewer\'s scope (service 404) is not found, never leaked', async () => {
    const err = Object.assign(new Error('Meeting not found'), { statusCode: 404 });
    const out = await getMeeting.execute({ id: 'other' }, detailCtx({ getInternalMeetingById: async () => { throw err; } }));
    assert.deepEqual(out, { found: false, matches: [] });
  });

  it('an id that is not an InternalMeeting (e.g. an interview room) is not found; no summary / recording read', async () => {
    const touched = [];
    const out = await getMeeting.execute({ id: 'meeting_abc123' }, detailCtx({
      getInternalMeetingById: async () => null,
      listRecordings: async () => { touched.push('recordings'); return []; },
      findSummary: async () => { touched.push('summary'); return SUMMARY; },
    }));
    assert.deepEqual(out, { found: false, matches: [] });
    assert.deepEqual(touched, []);
  });

  it('missing summary, roster and recording come back null / empty with a "not captured" note', async () => {
    const out = await getMeeting.execute({ id: 'm1' }, detailCtx({
      getInternalMeetingById: async () => ({ ...MEETING, participantRoster: [] }),
      listRecordings: async () => [],
      findSummary: async () => null,
    }));
    const m = out.meeting;
    assert.equal(m.summary, null);
    assert.match(m.summaryNote, /not captured in DharwinOne/);
    assert.deepEqual(m.attendees, []);
    assert.match(m.attendeesNote, /not captured in DharwinOne/);
    assert.equal(m.recorded, false);
    assert.equal(m.recordingLink, null);
  });

  it('by title + date searches the Meetings page query (IST day) and asks when several match', async () => {
    let seen;
    const out = await getMeeting.execute({ title: 'standup', date: '2026-09-28' }, detailCtx({
      queryInternalMeetings: async (filter, options, user) => {
        seen = { filter, options, user };
        return { totalResults: 2, results: [{ ...MEETING, title: 'Standup A' }, { ...MEETING, id: 'm2', title: 'Standup B' }] };
      },
    }));
    assert.equal(seen.user, VIEWER);
    assert.deepEqual(seen.filter.$and[1], {
      scheduledAt: { $gte: new Date('2026-09-27T18:30:00.000Z'), $lte: new Date('2026-09-28T18:29:59.999Z') },
    });
    assert.equal(out.found, false);
    assert.deepEqual(out.matches.map((r) => r.id), ['m1', 'm2']);
  });

  it('by title prefers a single exact title match', async () => {
    const out = await getMeeting.execute({ title: 'design review' }, detailCtx({
      queryInternalMeetings: async () => ({
        totalResults: 2, results: [{ ...MEETING, id: 'm2', title: 'Design review follow-up' }, MEETING],
      }),
    }));
    assert.equal(out.found, true);
    assert.equal(out.meeting.id, 'm1');
  });

  it('needs an id or a title', async () => {
    await assert.rejects(getMeeting.execute({}, detailCtx()), /id or a title/);
  });
});
