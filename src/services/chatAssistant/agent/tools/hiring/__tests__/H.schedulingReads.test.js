import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getInterview from '../getInterview.tool.js';
import getOffer from '../getOffer.tool.js';
import getInterviewerAvailability, { AVAILABILITY_ACCESS } from '../getInterviewerAvailability.tool.js';
import listAwaitingAvailability from '../listAwaitingAvailability.tool.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const NOW = new Date('2026-10-01T06:00:00.000Z'); // 11:30 IST
const A = '64a00000000000000000000a';
const B = '64a00000000000000000000b';
const viewer = (...perms) => ({
  id: 'v1', _id: 'v1', name: 'Viewer', email: 'viewer@x.com', authContext: { permissions: new Set(perms) },
});
const chain = (value) => {
  const c = {
    select: () => c,
    limit: () => c,
    sort: () => c,
    populate: () => c,
    lean: async () => value,
  };
  return c;
};
const ctxWith = (deps, user = viewer('interviews.manage')) => ({
  user, requestId: 'r', deps: { isAdmin: async () => false, now: () => NOW, ...deps },
});

describe('get_interview reminder', () => {
  const meeting = {
    id: 'm1', meetingId: 'meeting_abc', title: 'Round 1', candidate: { name: 'Ravi Kumar' },
    jobPosition: 'QA Engineer', status: 'scheduled', interviewResult: 'pending',
    scheduledAt: new Date('2026-10-08T04:30:00.000Z'), timezone: 'Asia/Kolkata', durationMinutes: 60,
    createdBy: { name: 'Asha' }, recruiter: { name: 'Asha' }, agents: [],
    remindAt: new Date('2026-10-08T03:30:00.000Z'),
    reminderSentAt: new Date('2026-10-08T03:31:00.000Z'),
  };
  const deps = (over = {}) => ({
    getMeetingById: async () => meeting,
    resolveJobTitle: async () => 'QA Engineer',
    listRecordings: async () => [],
    listEvaluations: async () => new Map(),
    getInterviewSummary: async () => null,
    activityGate: (_req, _res, next) => next(new Error('no logs')),
    writeViewAudit: async () => {},
    ...over,
  });

  it('returns reminderAt and reminderSent from the meeting', async () => {
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(deps(), viewer('interviews.read')));
    assert.equal(out.interview.reminderAt.toISOString(), '2026-10-08T03:30:00.000Z');
    assert.equal(out.interview.reminderSent, true);
    assert.equal(out.interview.reminderSentAt.toISOString(), '2026-10-08T03:31:00.000Z');
    assert.equal(out.interview.reminderNote, undefined);
  });

  it('missing reminder time is null and unsent is false — never a guessed time', async () => {
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(deps({
      getMeetingById: async () => ({ ...meeting, remindAt: null, reminderSentAt: null }),
    }), viewer('interviews.read')));
    assert.equal(out.interview.reminderAt, null);
    assert.equal(out.interview.reminderSent, false);
    assert.equal(out.interview.reminderSentAt, null);
    assert.match(out.interview.reminderNote, /No reminder time is stored/);
  });
});

describe('get_interviewer_availability access', () => {
  it('mirrors availability routes: own read, manage, or Administrator — not an unrelated permission', async () => {
    assert.equal((await checkAccessRule(AVAILABILITY_ACCESS, viewer('jobs.read'), { isAdmin: async () => false })).ok, false);
    assert.equal((await checkAccessRule(AVAILABILITY_ACCESS, viewer('interview-availability.read'))).ok, true);
    assert.equal((await checkAccessRule(AVAILABILITY_ACCESS, viewer('interviews.manage'))).ok, true);
    assert.equal((await checkAccessRule(AVAILABILITY_ACCESS, viewer('jobs.read'), { isAdmin: async () => true })).ok, true);
  });

  it('refuses another person before any user lookup when the viewer cannot open their hours', async () => {
    const out = await getInterviewerAvailability.execute(
      { interviewers: ['Priya Shah'] },
      ctxWith({
        isAdmin: async () => false,
        User: { find: () => assert.fail('looked up a name'), findById: () => assert.fail('looked up an id') },
      }, viewer('interview-availability.read')),
    );
    assert.match(out.error, /interviews\.manage/);
  });
});

describe('get_interviewer_availability slots', () => {
  const users = [
    { _id: A, name: 'Priya Shah', email: 'priya@x.test' },
    { _id: B, name: 'Vikram Shah', email: 'vik@x.test' },
  ];
  const hours = (id) => ({
    user: id, timezone: 'Asia/Kolkata', bufferMinutes: 0,
    weekly: [{ day: 3, start: '10:00', end: '12:00' }], overrides: [],
  });
  const meeting = {
    status: 'scheduled', scheduledAt: new Date('2026-10-07T04:30:00.000Z'), durationMinutes: 60,
    hosts: [{ email: 'priya@x.test' }], agents: [],
  };

  function models({ avail = [hours(A), hours(B)], meetings = [meeting], findById } = {}) {
    const calls = { meetings: 0 };
    return {
      calls,
      InterviewerAvailability: { find: () => chain(avail) },
      User: {
        find: () => chain(users),
        findById: (id) => chain(findById ? findById(id) : users.find((u) => u._id === id) || null),
      },
      Meeting: { find: () => { calls.meetings += 1; return chain(meetings); } },
      InternalMeeting: { find: () => chain([]) },
      InterviewHold: { find: () => chain([]) },
    };
  }

  it('subtracts a busy interview and returns only the common free hour, spoken in IST', async () => {
    const fake = models();
    const out = await getInterviewerAvailability.execute(
      { interviewers: [A, B], window: { from: '2026-10-07', to: '2026-10-07' } },
      ctxWith({ ...fake, now: () => new Date('2026-10-01T00:00:00.000Z') }),
    );
    const priya = out.interviewers.find((p) => p.id === A);
    const vik = out.interviewers.find((p) => p.id === B);
    assert.equal(priya.availabilitySet, true);
    assert.deepEqual(priya.freeSlots.map((s) => s.start), ['2026-10-07T05:30:00.000Z']);
    assert.deepEqual(vik.freeSlots.map((s) => s.start), ['2026-10-07T04:30:00.000Z', '2026-10-07T05:30:00.000Z']);
    assert.deepEqual(out.commonFree.map((s) => s.start), ['2026-10-07T05:30:00.000Z']);
    assert.match(out.commonFree[0].spoken, /11 AM/);
    assert.match(out.commonFree[0].spoken, /India time/);
    assert.equal(out.displayTimezone, 'Asia/Kolkata');
    assert.doesNotMatch(JSON.stringify(out), /priya@x\.test|vik@x\.test/);
  });

  it('no stored hours means not bookable — no invented slots and no busy lookup', async () => {
    const fake = models({ avail: [], meetings: [] });
    const out = await getInterviewerAvailability.execute(
      { interviewers: [A], window: { from: '2026-10-07', to: '2026-10-07' } },
      ctxWith({ ...fake, now: () => new Date('2026-10-01T00:00:00.000Z') }),
    );
    assert.equal(out.interviewers[0].availabilitySet, false);
    assert.deepEqual(out.interviewers[0].freeSlots, []);
    assert.equal(fake.calls.meetings, 0);
    assert.equal(out.commonFree, null);
  });

  it('an Administrator without interviews.manage sees stored hours, not open slots', async () => {
    let meetings = 0;
    const out = await getInterviewerAvailability.execute(
      { interviewers: ['Priya Shah'] },
      ctxWith({
        isAdmin: async () => true,
        User: { find: () => chain([{ _id: A, name: 'Priya Shah', email: 'priya@x.test' }]), findById: () => chain(null) },
        InterviewerAvailability: { find: () => chain([hours(A)]) },
        Meeting: { find: () => { meetings += 1; return chain([]); } },
      }, viewer('interview-availability.read')),
    );
    assert.equal(meetings, 0);
    assert.equal(out.interviewers[0].freeSlots, null);
    assert.match(out.freeSlotsNote, /interviews\.manage/);
    assert.equal(out.interviewers[0].weekly[0].start, '10:00');
    assert.doesNotMatch(JSON.stringify(out), /priya@x\.test/);
  });

  it('several name matches come back as matches, with no email', async () => {
    const out = await getInterviewerAvailability.execute(
      { interviewers: ['Shah'] },
      ctxWith({
        User: {
          find: () => chain([
            { _id: A, name: 'Priya Shah', email: 'priya@x.test' },
            { _id: B, name: 'Vikram Shah', email: 'vik@x.test' },
          ]),
          findById: () => chain(null),
        },
      }),
    );
    assert.equal(out.ambiguous[0].matches.length, 2);
    assert.doesNotMatch(JSON.stringify(out), /@/);
  });
});

describe('list_awaiting_availability', () => {
  const inApp = {
    _id: 'app-in', candidate: { fullName: 'Ravi Kumar', email: 'ravi@cand.test' }, job: { title: 'QA Engineer' }, status: 'Applied',
  };
  const outApp = {
    _id: 'app-out', candidate: { fullName: 'Hidden Person', email: 'h@cand.test' }, job: { title: 'Secret Role' }, status: 'Applied',
  };
  const relayApp = {
    _id: 'app-relay', candidate: { _id: 'relay-candidate', fullName: 'Relay Bot' }, job: { title: 'QA Engineer' }, status: 'Applied',
  };

  function apps(q) {
    const text = JSON.stringify(q);
    if (text.includes('"$or"')) return [];
    const scoped = text.includes('job-visible');
    const hidesRelay = text.includes('relay-candidate');
    let rows = [inApp, outApp, relayApp];
    if (scoped) rows = rows.filter((a) => a._id !== 'app-out');
    if (hidesRelay) rows = rows.filter((a) => a._id !== 'app-relay');
    const inn = q?.$and?.find((p) => p._id)?._id?.$in?.map(String);
    if (inn) rows = rows.filter((a) => inn.includes(a._id));
    return rows;
  }

  const baseDeps = (over = {}) => ({
    applicationScope: async () => ({ filter: { job: { $in: ['job-visible'] } } }),
    Employee: { find: () => chain([{ _id: 'relay-candidate' }]) },
    EmailLog: { find: () => chain([
      { metadata: { applicationId: 'app-in' }, sentAt: new Date('2026-09-20T04:30:00.000Z'), createdAt: new Date('2026-09-20T04:30:00.000Z') },
      { metadata: { applicationId: 'app-out' }, sentAt: new Date('2026-09-01T00:00:00.000Z') },
      { metadata: { applicationId: 'app-relay' }, sentAt: new Date('2026-09-18T00:00:00.000Z') },
      { metadata: { applicationId: 'app-nodate' }, sentAt: null, createdAt: null },
    ]) },
    CallRecord: { find: () => chain([]) },
    InterviewHold: { distinct: async () => [] },
    JobApplication: { find: (q) => chain(apps(q)) },
    ...over,
  });

  it('lists in-scope candidates with link sent date and IST age, and hides everyone else', async () => {
    const out = await listAwaitingAvailability.execute({}, ctxWith(baseDeps(), viewer('candidates.read')));
    const names = out.records.map((r) => r.candidate);
    assert.deepEqual(names, ['Ravi Kumar']);
    assert.equal(out.records[0].linkSentAt.toISOString(), '2026-09-20T04:30:00.000Z');
    assert.equal(out.records[0].ageDays, 11);
    assert.equal(out.records[0].job, 'QA Engineer');
    assert.equal(out.scopedToYou, true);
    assert.doesNotMatch(JSON.stringify(out), /ravi@cand\.test|Hidden Person|Relay Bot/);
  });

  it('a current hold means they picked a slot, so they are left out', async () => {
    const out = await listAwaitingAvailability.execute({}, ctxWith(baseDeps({
      InterviewHold: { distinct: async (_f, q) => {
        assert.ok(q.status.$in.includes('held'));
        assert.ok(q.status.$in.includes('approved'));
        return ['app-in'];
      } },
    }), viewer()));
    assert.deepEqual(out.records.map((r) => r.applicationId), []);
  });

  it('a missing send timestamp stays null — the age is not guessed', async () => {
    const out = await listAwaitingAvailability.execute({}, ctxWith(baseDeps({
      EmailLog: { find: () => chain([{ metadata: { applicationId: 'app-in' }, sentAt: null, createdAt: null }]) },
      Employee: { find: () => chain([]) },
      JobApplication: { find: (q) => chain(String(JSON.stringify(q)).includes('app-in') ? [inApp] : []) },
    }), viewer()));
    assert.equal(out.records[0].linkSentAt, null);
    assert.equal(out.records[0].ageDays, null);
  });

  it('an empty Applications scope returns nothing and does not read booking logs', async () => {
    const out = await listAwaitingAvailability.execute({}, ctxWith({
      applicationScope: async (user) => {
        assert.equal(user.id, 'v1');
        return { filter: { _id: { $in: [] } } };
      },
      EmailLog: { find: () => assert.fail('read email logs') },
      CallRecord: { find: () => assert.fail('read calls') },
    }, viewer()));
    assert.equal(out.total, 0);
    assert.deepEqual(out.records, []);
  });

  it('a call-record bookingLinkSentAt counts, still inside application scope', async () => {
    let seen;
    const out = await listAwaitingAvailability.execute({}, ctxWith({
      applicationScope: async () => ({ filter: { job: { $in: ['job-visible'] } } }),
      Employee: { find: () => chain([]) },
      EmailLog: { find: () => chain([]) },
      CallRecord: { find: () => chain([{ bookingLinkSentAt: new Date('2026-09-28T04:30:00.000Z'), candidate: 'cand-1', job: 'job-visible' }]) },
      InterviewHold: { distinct: async () => [] },
      JobApplication: { find: (q) => {
        seen = q;
        const text = JSON.stringify(q);
        if (!text.includes('job-visible')) return chain([outApp]);
        if (text.includes('"$or"')) return chain([{ _id: 'app-in', candidate: 'cand-1', job: 'job-visible' }]);
        return chain([inApp]);
      } },
    }, viewer()));
    assert.match(JSON.stringify(seen), /job-visible/);
    assert.equal(out.records[0].candidate, 'Ravi Kumar');
    assert.equal(out.records[0].ageDays, 3);
  });
});

describe('get_offer rejection reason (J15)', () => {
  it('leaves rejectionReason out — the Offers page never shows it', async () => {
    const offer = {
      _id: 'o1', offerCode: 'OFF-2026-0012', status: 'Rejected', candidate: { fullName: 'Ravi Kumar' },
      job: { title: 'QA Engineer' }, createdBy: { name: 'Asha' }, createdAt: '2026-09-18T05:00:00.000Z',
      rejectedAt: '2026-09-25T00:00:00.000Z', rejectionReason: 'Took another offer',
    };
    const out = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({
      queryOffers: async () => ({ totalResults: 1, results: [offer], page: 1, totalPages: 1 }),
      RecruiterActivityLog: { findOne: () => chain(null) },
    }, viewer('offers.read')));
    assert.equal(out.rejectionReason, undefined);
    assert.equal(out.status, 'Rejected');
    assert.doesNotMatch(JSON.stringify(out), /rejectionReason|Took another offer/);
  });
});
