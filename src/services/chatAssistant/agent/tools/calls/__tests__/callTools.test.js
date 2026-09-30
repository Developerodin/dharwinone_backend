import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countCallRecords from '../countCallRecords.tool.js';
import listCallRecords from '../listCallRecords.tool.js';
import getCallRecord from '../getCallRecord.tool.js';
import getCallMetrics from '../getCallMetrics.tool.js';
import listCallFollowups from '../listCallFollowups.tool.js';
import callsDomain from '../index.js';
import { CALLBACK_GRACE_MS } from '../followups.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const ALL_TOOLS = [countCallRecords, listCallRecords, getCallRecord, getCallMetrics, listCallFollowups];
const UID = '64b0000000000000000000a1';
const OTHER = '64b0000000000000000000b2';
const CAND = '64b0000000000000000000c3';
const JOB = '64b0000000000000000000d4';

const viewer = (...perms) => ({ id: UID, _id: UID, name: 'Asha', authContext: { permissions: new Set(perms) } });
const FULL = viewer('calls.view', 'call-ai.read', 'call-transcripts.read', 'call-recording.view', 'candidates.read');
const PLAIN = viewer('calls.view');

/** listCallRecords fake: one page of rows; every call lands in `calls`. */
function fakeList(rows, { total, calls = [] } = {}) {
  return async (opts) => {
    calls.push(opts);
    return { results: rows.slice(0, opts.limit), total: total ?? rows.length, totalPages: 1, page: 1, limit: opts.limit };
  };
}

const ctxWith = (deps, user = PLAIN) => ({
  user,
  requestId: 'r',
  deps: { userIsAdmin: async () => false, ...deps },
});

const row = (over = {}) => ({
  _id: 'x',
  executionId: 'exec-1',
  createdAt: new Date('2026-09-10T06:00:00.000Z'),
  displayName: 'Priya Shah',
  displayCategory: 'Student/Candidate',
  toPhoneNumber: '+919800000001',
  fromPhoneNumber: '+14155550100',
  callSource: 'ai_agent',
  telephonyData: { provider: 'plivo', hangup_by: 'Callee', hangup_reason: 'Call recipient hungup' },
  duration: 95,
  status: 'completed',
  createdBy: UID,
  recordingUrl: 'https://provider.example/rec.wav',
  transcript: 'user: hello',
  verification: { callOutcome: 'fully_confirmed', stillInterested: 'interested' },
  ...over,
});

/** Chainable JobApplication / CallRecord query fake. */
function fakeQuery(result) {
  const q = {
    sort: () => q, limit: () => q, select: () => q, populate: () => q,
    lean: async () => result,
  };
  return q;
}

describe('calls domain', () => {
  it('exports a one-line summary and all five tools', () => {
    assert.ok(callsDomain.summary.length <= 120 && !/\n/.test(callsDomain.summary));
    assert.deepEqual(callsDomain.tools.map((t) => t.name), [
      'count_call_records', 'list_call_records', 'get_call_record', 'get_call_metrics', 'list_call_followups',
    ]);
  });

  it('every tool is denied without calls.view and allowed with it (or an alias)', async () => {
    for (const tool of ALL_TOOLS) {
      assert.equal((await checkAccessRule(tool.access, viewer('jobs.read'))).ok, false, tool.name);
      assert.equal((await checkAccessRule(tool.access, viewer('calls.view'))).ok, true, tool.name);
      assert.equal((await checkAccessRule(tool.access, viewer('calling.manage'))).ok, true, tool.name);
    }
  });

  it('fails closed without a user id', async () => {
    const deps = { listCallRecords: () => assert.fail('must not query'), countCallRecords: () => assert.fail('must not query') };
    for (const tool of ALL_TOOLS) {
      await assert.rejects(
        tool.execute({ id: 'e', person: 'Priya', kind: 'notYetCalled' }, { deps }),
        /user with an id/,
        tool.name,
      );
    }
  });
});

describe('count_call_records', () => {
  it('passes the viewer scope and page filters to one exact count', async () => {
    const calls = [];
    const out = await countCallRecords.execute(
      { filters: { person: '  Priya ', status: 'missed', callType: 'telephony' } },
      ctxWith({ countCallRecords: async (o) => { calls.push(o); return o.callSourceMissing ? 0 : 42; } }),
    );
    assert.equal(out.total, 42);
    assert.equal('unclassifiedCalls' in out, false, 'zero unclassified calls is not reported');
    const main = calls.find((c) => !c.callSourceMissing);
    assert.deepEqual(main, {
      search: 'Priya', status: 'missed', callSource: 'telephony', sortBy: 'createdAt', order: 'desc', userId: UID, isAdmin: false,
    });
  });

  it('passes isAdmin from userIsAdmin, never from the filters', async () => {
    const calls = [];
    await countCallRecords.execute({}, ctxWith({ userIsAdmin: async () => true, countCallRecords: async (o) => { calls.push(o); return 0; } }));
    assert.equal(calls[0].isAdmin, true);
  });

  it('sends every filter to Mongo: IST window bounds, direction, provider, mine, candidate id (no JS scan)', async () => {
    const calls = [];
    await countCallRecords.execute(
      { filters: { calledBetween: { from: '2026-09-29', to: '2026-09-30' }, direction: 'inbound', provider: 'twilio', mine: true, person: CAND } },
      ctxWith({ countCallRecords: async (o) => { calls.push(o); return 3; }, listCallRecords: () => assert.fail('no scan') }),
    );
    assert.deepEqual(calls[0], {
      candidateId: CAND,
      direction: 'inbound',
      provider: 'twilio',
      createdFrom: '2026-09-28T18:30:00.000Z',
      createdTo: '2026-09-30T18:29:59.999Z',
      createdBy: UID,
      sortBy: 'createdAt',
      order: 'desc',
      userId: UID,
      isAdmin: false,
    });
  });

  it('placedBy passes through as createdBy; mine wins over placedBy', async () => {
    const calls = [];
    const deps = { countCallRecords: async (o) => { calls.push(o); return 1; } };
    await countCallRecords.execute({ filters: { placedBy: OTHER } }, ctxWith(deps));
    await countCallRecords.execute({ filters: { placedBy: OTHER, mine: true } }, ctxWith(deps));
    assert.deepEqual(calls.map((c) => c.createdBy), [OTHER, UID]);
  });

  it('rejects a placedBy that is not an id', async () => {
    const { error } = countCallRecords.input.validate({ filters: { placedBy: 'x'.repeat(24) } });
    assert.ok(error);
  });

  it('reports older unclassified calls when a call type is asked for', async () => {
    const out = await countCallRecords.execute(
      { filters: { callType: 'ai_agent' } },
      ctxWith({ countCallRecords: async (o) => (o.callSourceMissing ? 700 : 2) }),
    );
    assert.deepEqual([out.total, out.unclassifiedCalls], [2, 700]);
  });

  it('groupBy day asks the service for IST days and returns them newest first', async () => {
    let seen;
    const out = await countCallRecords.execute(
      { groupBy: 'day' },
      ctxWith({
        groupCallRecords: async (o, g) => {
          seen = g;
          return { total: 3, groups: [{ value: '2026-09-29', count: 1 }, { value: '2026-09-30', count: 2 }] };
        },
      }),
    );
    assert.deepEqual(seen, { groupBy: 'day', timezone: 'Asia/Kolkata' });
    assert.equal(out.total, 3);
    assert.deepEqual(out.groups, [{ value: '2026-09-30', count: 2 }, { value: '2026-09-29', count: 1 }]);
  });

  it('groupBy caller names callers through getUserByIdForRequester; hidden users stay anonymous', async () => {
    const seen = [];
    const out = await countCallRecords.execute(
      { groupBy: 'caller' },
      ctxWith({
        groupCallRecords: async () => ({
          total: 4,
          groups: [{ value: OTHER, count: 1 }, { value: UID, count: 2 }, { value: null, count: 1 }],
        }),
        getUserByIdForRequester: async (id, u) => {
          seen.push(u);
          if (id === OTHER) throw new Error('User not found');
          return { name: 'Asha', password: 'x' };
        },
      }),
    );
    assert.ok(seen.every((u) => u.id === UID));
    assert.deepEqual(out.groups, [
      { value: 'Asha', userId: UID, count: 2 },
      { value: 'Unknown user', userId: OTHER, count: 1 },
      { value: 'No caller recorded', userId: null, count: 1 },
    ]);
  });

  it('groupBy hangupBy explains the provider value and labels missing ones', async () => {
    const out = await countCallRecords.execute(
      { groupBy: 'hangupBy' },
      ctxWith({ groupCallRecords: async () => ({ total: 5, groups: [{ value: 'Callee', count: 3 }, { value: null, count: 2 }] }) }),
    );
    assert.deepEqual(out.groups, [
      { value: 'Callee', count: 3, meaning: 'the person called hung up' },
      { value: 'Not recorded', count: 2 },
    ]);
  });

  it('render gives a count fact without groupBy and a table (no facts) with it', () => {
    assert.deepEqual(countCallRecords.render({ total: 5 }).facts.counts[0], { kind: 'count_call_records', label: 'calls', total: 5 });
    const r = countCallRecords.render({ total: 3, groupBy: 'status', groups: [{ value: 'completed', count: 3 }] });
    assert.equal(r.facts, undefined);
    assert.equal(r.blocks[0].rows[0].value, 'completed');
  });
});

describe('list_call_records', () => {
  it('strips the AI outcome without call-ai.read, never leaks recording URLs, exposes hang-up side', async () => {
    const out = await listCallRecords.execute({}, ctxWith({ listCallRecords: fakeList([row()], { total: 7 }) }));
    assert.equal(out.total, 7);
    assert.equal(out.aiFieldsHidden, true);
    const [r] = out.records;
    assert.equal(JSON.stringify(out).includes('provider.example'), false);
    assert.equal(JSON.stringify(out).includes('hello'), false);
    assert.deepEqual(r, {
      id: 'exec-1', when: row().createdAt, person: 'Priya Shah', category: 'Student/Candidate',
      toNumber: '+919800000001', fromNumber: '+14155550100', callType: 'ai_agent', direction: null,
      provider: 'plivo', durationSeconds: 95, status: 'completed', hangupBy: 'Callee',
      hangupReason: 'Call recipient hungup', outcome: null, recordingAvailable: true,
    });
    assert.match(out.notCaptured.attemptNumber, /not captured/);
  });

  it('keeps the AI outcome with call-ai.read', async () => {
    const out = await listCallRecords.execute({}, ctxWith({ listCallRecords: fakeList([row()]) }, FULL));
    assert.equal(out.records[0].outcome, 'fully_confirmed');
    assert.equal('aiFieldsHidden' in out, false);
  });

  it('filters go to the service in one call and total is its exact count', async () => {
    const calls = [];
    const out = await listCallRecords.execute(
      { filters: { direction: 'inbound', provider: 'twilio', person: CAND }, limit: 1 },
      ctxWith({ listCallRecords: fakeList([row({ telephonyData: { direction: 'inbound', provider: 'twilio' } })], { total: 2, calls }) }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].search, undefined, 'a candidate id is matched exactly, not sent as page search');
    assert.deepEqual([calls[0].candidateId, calls[0].direction, calls[0].provider, calls[0].limit], [CAND, 'inbound', 'twilio', 1]);
    assert.equal(out.total, 2);
    assert.equal(out.records[0].direction, 'inbound');
    assert.equal(out.records[0].hangupBy, null);
  });

  it('rejects a malformed day', async () => {
    await assert.rejects(
      listCallRecords.execute({ filters: { calledBetween: { from: '2026/09/01' } } }, ctxWith({ listCallRecords: fakeList([]) })),
      /YYYY-MM-DD/,
    );
  });
});

describe('get_call_record', () => {
  const recordDeps = (doc, extra = {}) => ({
    getCallRecordScopeFields: async () => ({ job: null, candidate: CAND, createdBy: UID }),
    userCanAccessCallRecord: async () => true,
    CallRecord: { findOne: (q) => ({ lean: async () => (q.executionId === doc?.executionId ? doc : null) }) },
    resolveCallRecordingSources: async () => ({ bolnaUrl: 'https://b', plivo: [], twilioUrl: null }),
    getArchivePresence: async () => ({ bolna: false, plivo: true, twilio: false }),
    ...extra,
  });
  const fullDoc = row({
    candidate: CAND,
    businessName: 'Priya Shah',
    purpose: 'job_application_verification',
    completedAt: new Date('2026-09-10T06:05:00.000Z'),
    extractedData: { General: { 'Call Summary': { subjective: 'Candidate is keen, based in Pune.' } } },
    verification: {
      stillInterested: 'interested', currentLocation: 'Pune', availability: 'Weekdays after 5pm',
      nameConfirmed: true, jobConfirmed: false, callOutcome: 'partially_confirmed', interviewSlotOutcome: null,
    },
    callQuality: { status: 'ok', reasons: [] },
  });

  it('refuses a call outside the viewer\'s scope before reading it', async () => {
    const out = await getCallRecord.execute({ id: 'exec-1' }, ctxWith(recordDeps(fullDoc, {
      userCanAccessCallRecord: async (scope, v) => { assert.deepEqual(v, { userId: UID, isAdmin: false }); return false; },
      CallRecord: { findOne: () => assert.fail('must not read the record') },
    })));
    assert.equal(out.forbidden, true);
  });

  it('returns AI answers as attributed statements, transcript, playback links and hang-up side with every toggle', async () => {
    const out = await getCallRecord.execute({ id: 'exec-1' }, ctxWith(recordDeps(fullDoc), FULL));
    const ai = out.aiInsights;
    assert.equal(ai.interest, 'On 2026-09-10 the candidate said they are still interested.');
    assert.equal(ai.location, 'On 2026-09-10 the candidate said their current location is "Pune".');
    assert.equal(ai.availability, 'On 2026-09-10 the candidate said their availability is "Weekdays after 5pm".');
    assert.equal(ai.jobConfirmation, 'On 2026-09-10 the candidate did not confirm the job they applied for.');
    assert.match(ai.summary, /^AI summary of the call on 2026-09-10: "Candidate is keen/);
    for (const k of ['salary', 'joiningDate', 'questions', 'concerns', 'otherOffers']) assert.equal(ai[k], null, k);
    assert.equal(out.transcript, 'user: hello');
    assert.deepEqual(out.recordings, {
      bolna: { available: true, channel: 'agent_only', streamUrl: '/v1/bolna/call-records/exec-1/recordings/bolna' },
      plivo: { available: true, channel: 'dual', streamUrl: '/v1/bolna/call-records/exec-1/recordings/plivo' },
      twilio: { available: false },
    });
    assert.equal(out.call.person, 'Priya Shah');
    assert.equal(out.call.outcome, 'partially_confirmed');
    assert.equal(out.call.hangupBy, 'Callee');
    assert.equal(out.hangupMeaning, 'the person called hung up');
  });

  it('hides transcript, AI fields and recordings without the matching toggles', async () => {
    const out = await getCallRecord.execute({ id: 'exec-1' }, ctxWith(recordDeps(fullDoc, {
      resolveCallRecordingSources: () => assert.fail('must not resolve recordings'),
    })));
    assert.equal(out.aiInsights, null);
    assert.equal(out.transcript, null);
    assert.equal(out.recordings, null);
    assert.equal(out.call.outcome, null);
    assert.deepEqual(
      [out.aiFieldsHidden, out.transcriptHidden, out.recordingsHidden],
      [true, true, true],
    );
    assert.equal(JSON.stringify(out).includes('Pune'), false);
  });

  it('missing AI fields come back null, not invented', async () => {
    const bare = row({ verification: null, extractedData: null, intelligence: null, transcript: null });
    const out = await getCallRecord.execute({ id: 'exec-1' }, ctxWith(recordDeps(bare), FULL));
    assert.equal(out.aiInsights.summary, null);
    assert.equal(out.aiInsights.interest, null);
    assert.equal(out.aiInsights.location, null);
    assert.equal(out.transcript, null);
  });

  it('"latest call with <person>" uses the page search scoped to the viewer, then the same access check', async () => {
    const calls = [];
    const checked = [];
    const out = await getCallRecord.execute({ person: 'Priya' }, ctxWith({
      ...recordDeps(fullDoc, { userCanAccessCallRecord: async (s, v) => { checked.push(v); return true; } }),
      listCallRecords: fakeList([row({ executionId: 'exec-1', displayName: 'Priya S.' })], { calls }),
    }));
    assert.deepEqual(
      { search: calls[0].search, userId: calls[0].userId, limit: calls[0].limit, order: calls[0].order },
      { search: 'Priya', userId: UID, limit: 1, order: 'desc' },
    );
    assert.equal(checked.length, 1);
    assert.equal(out.call.id, 'exec-1');
    assert.equal(out.call.person, 'Priya S.');
  });

  it('reports notFound for an unknown id or a person with no visible calls', async () => {
    const byId = await getCallRecord.execute({ id: 'nope' }, ctxWith({ ...recordDeps(fullDoc), getCallRecordScopeFields: async () => null }));
    assert.equal(byId.notFound, true);
    const byPerson = await getCallRecord.execute({ person: 'Nobody' }, ctxWith({ listCallRecords: fakeList([]) }));
    assert.deepEqual(byPerson, { notFound: true, searchedFor: 'Nobody' });
  });

  it('needs an id or a person', async () => {
    await assert.rejects(getCallRecord.execute({}, ctxWith({})), /id or person/);
  });
});

/** Follow-up deps: buildApplicantQuery returns `scope`; JobApplication records every filter. */
function followupFakes({ scope = { job: { $in: [JOB] } }, apps = [], called = [], counts = {} } = {}) {
  const seen = { builds: [], counts: [], finds: [] };
  return {
    seen,
    deps: {
      buildApplicantQuery: async (filter, user) => { seen.builds.push({ filter, user }); return { query: scope }; },
      JobApplication: {
        countDocuments: async (f) => {
          seen.counts.push(f);
          const at = f.$and[2].verificationCallbackAt;
          return at.$lt ? (counts.overdue ?? 0) : (counts.due ?? 0);
        },
        find: (f) => { seen.finds.push(f); return fakeQuery(f._id ? apps.filter((a) => f._id.$in.includes(a._id)) : apps); },
      },
      CallRecord: { find: () => fakeQuery(called) },
    },
  };
}

describe('get_call_metrics', () => {
  const summary = {
    byStatus: { completed: 3, failed: 1, no_answer: 1, in_progress: 1 },
    avgCompletedDurationSeconds: 90.4,
    completedWithDuration: 2,
    interest: { interested: 1, not_interested: 1 },
  };

  it('computes answer rate, average talk time, failed, interest rate and applicant follow-ups', async () => {
    const f = followupFakes({
      counts: { due: 2, overdue: 1 },
      apps: [
        { _id: 'a1', candidate: CAND, job: JOB, verificationCallStatus: 'failed' },
        { _id: 'a2', candidate: OTHER, job: JOB },
      ],
      called: [{ candidate: CAND, job: JOB }],
    });
    let includeInterest;
    const out = await getCallMetrics.execute(
      { filters: { calledBetween: { from: '2026-09-01', to: '2026-09-30' } } },
      ctxWith({ ...f.deps, summarizeCallRecords: async (o, opt) => { includeInterest = opt.includeInterest; return summary; } }, FULL),
    );
    assert.equal(includeInterest, true);
    assert.equal(out.totalCalls, 6);
    assert.equal(out.finishedCalls, 5);
    assert.equal(out.answeredCalls, 3);
    assert.equal(out.answerRate, 0.6);
    assert.equal(out.avgDurationSeconds, 90);
    assert.equal(out.failedCalls, 1);
    assert.deepEqual(out.interestConfirmed, { interested: 1, answeredInterestQuestion: 2, rate: 0.5 });
    assert.deepEqual([out.notYetCalledApplicants, out.callbacksDue, out.callbacksOverdue], [1, 2, 1]);
    const notCalledBuild = f.seen.builds.find((b) => b.filter.dateFrom);
    assert.deepEqual(notCalledBuild.filter, {
      excludeInternal: true, dateFrom: '2026-08-31T18:30:00.000Z', dateTo: '2026-09-30T18:29:59.999Z',
    });
  });

  it('never asks Mongo for AI answers without call-ai.read; applicant metrics hidden without candidates.read', async () => {
    let includeInterest;
    const out = await getCallMetrics.execute({}, ctxWith({
      summarizeCallRecords: async (o, opt) => { includeInterest = opt.includeInterest; return { byStatus: summary.byStatus }; },
      buildApplicantQuery: () => assert.fail('no applications access'),
    }));
    assert.equal(includeInterest, false);
    assert.equal(out.interestConfirmed, null);
    assert.equal(out.aiFieldsHidden, true);
    assert.equal(out.answerRate, 0.6);
    assert.equal(out.notYetCalledApplicants, null);
    assert.match(out.applicantMetricsHidden, /candidates\.read/);
  });

  it('an empty window gives null rates, not zero', async () => {
    const f = followupFakes();
    const out = await getCallMetrics.execute({}, ctxWith({
      ...f.deps,
      summarizeCallRecords: async () => ({ byStatus: {}, avgCompletedDurationSeconds: null, interest: {} }),
    }, FULL));
    assert.equal(out.totalCalls, 0);
    assert.equal(out.answerRate, null);
    assert.equal(out.avgDurationSeconds, null);
    assert.equal(out.interestConfirmed.rate, null);
    assert.equal(out.notYetCalledApplicants, 0);
  });
});

describe('list_call_followups', () => {
  const NOW = Date.now();

  it('refuses without the Applications page permission', async () => {
    const out = await listCallFollowups.execute(
      { kind: 'callbackRequested' },
      ctxWith({ buildApplicantQuery: () => assert.fail('must not query') }),
    );
    assert.equal(out.forbidden, true);
  });

  it('callbacks due: Applications-page scope, open applications, callback time not yet past the grace window', async () => {
    const f = followupFakes({
      counts: { due: 3 },
      apps: [{
        _id: 'a1', candidate: { fullName: 'Priya Shah' }, job: { title: 'Nurse' }, status: 'Applied',
        createdAt: new Date('2026-09-01'), verificationCallbackAt: new Date(NOW + 60000), verificationCallbackCount: 1,
      }],
    });
    const out = await listCallFollowups.execute({ kind: 'callbackRequested', jobId: JOB, limit: 5 }, ctxWith(f.deps, FULL));
    assert.equal(out.total, 3);
    assert.deepEqual(f.seen.builds[0].filter, { excludeInternal: true, jobId: JOB });
    assert.equal(f.seen.builds[0].user.id, UID);
    const [scope, open, when] = f.seen.counts[0].$and;
    assert.deepEqual(scope, { job: { $in: [JOB] } });
    assert.deepEqual(open, { status: { $nin: ['Offered', 'Hired', 'Rejected'] }, verificationCallStatus: { $ne: 'withdrawn' } });
    const cutoff = when.verificationCallbackAt.$gte.getTime();
    assert.ok(Math.abs(cutoff - (NOW - CALLBACK_GRACE_MS)) < 5000);
    assert.equal(out.records[0].applicant, 'Priya Shah');
    assert.equal(out.records[0].callbacksBooked, 1);
    assert.equal(listCallFollowups.render(out).facts.counts[0].label, 'applications');
  });

  it('callbacks overdue use the other side of the same cutoff', async () => {
    const f = followupFakes({ counts: { overdue: 4 } });
    const out = await listCallFollowups.execute({ kind: 'callbackOverdue' }, ctxWith(f.deps, FULL));
    assert.equal(out.total, 4);
    assert.ok(f.seen.counts[0].$and[2].verificationCallbackAt.$lt instanceof Date);
  });

  it('not yet called = open, never-dialled applications with no call record for that candidate + job', async () => {
    const f = followupFakes({
      apps: [
        { _id: 'a1', candidate: CAND, job: JOB },
        { _id: 'a2', candidate: OTHER, job: JOB, verificationCallStatus: 'failed' },
        { _id: 'a3', candidate: OTHER, job: CAND },
      ],
      called: [{ candidate: CAND, job: JOB }],
    });
    const out = await listCallFollowups.execute(
      { kind: 'notYetCalled', appliedBetween: { from: '2026-09-01', to: '2026-09-01' }, limit: 1 },
      ctxWith(f.deps, FULL),
    );
    assert.equal(out.total, 2);
    assert.deepEqual(out.byVerificationStatus, { failed: 1, 'never attempted': 1 });
    assert.equal(out.records.length, 1);
    assert.deepEqual(f.seen.finds[0].$and[2], { verificationCallExecutionId: { $in: [null, ''] } });
    assert.equal(f.seen.builds[0].filter.dateFrom, '2026-08-31T18:30:00.000Z');
  });

  it('an empty Applications-page scope short-circuits to zero', async () => {
    const f = followupFakes({ scope: { _id: { $in: [] } } });
    const out = await listCallFollowups.execute({ kind: 'notYetCalled' }, ctxWith(f.deps, FULL));
    assert.deepEqual([out.total, out.records.length, f.seen.finds.length], [0, 0, 0]);
  });
});
