import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getInterview from '../getInterview.tool.js';
import getInterviewTranscript from '../getInterviewTranscript.tool.js';
import listInterviews from '../listInterviews.tool.js';
import countInterviews from '../countInterviews.tool.js';
import { interviewMongoFilter } from '../common.js';
import { panelOverlaps, OVERLAP_SCAN_LIMIT, MAX_FULL_TEXT_CHARS, MAX_DURATION_MIN } from '../interviewDetail.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const viewer = (...perms) => ({ id: 'v1', _id: 'v1', authContext: { permissions: new Set(perms) } });
const ctxWith = (deps, user = viewer('interviews.read')) => ({ user, requestId: 'r', deps });
const paged = (totalResults, results = []) => ({ totalResults, results, page: 1, totalPages: 1 });
const notFound = (msg = 'Not found') => Object.assign(new Error(msg), { statusCode: 404 });
const denyGate = (_req, _res, next) => next(new Error('forbidden'));
const allowGate = (_req, _res, next) => next();

const MEETING = {
  id: 'm1', meetingId: 'meeting_abc', title: 'Round 1 — QA', candidate: { name: 'Ravi Kumar', email: 'ravi@c.test', phone: '999' },
  jobPosition: '64b000000000000000000001', jobId: '64b000000000000000000001', round: { label: 'Technical' },
  interviewType: 'Video', scheduledAt: new Date('2026-09-29T05:00:00.000Z'), timezone: 'Asia/Kolkata',
  durationMinutes: 45, status: 'ended', interviewResult: 'pending', createdBy: { name: 'Asha Rao', password: 'x' },
  recruiter: { id: 'u1', name: 'Asha Rao', email: 'asha@x.test' }, agents: [{ id: 'u2', name: 'Vikram', email: 'vik@x.test' }],
  participantRoster: [
    { identity: 'i1', role: 'candidate', displayName: 'Ravi Kumar', emailHash: 'h', firstJoinedAt: new Date('2026-09-29T05:01:00Z') },
  ],
  createdAt: new Date('2026-09-20T05:00:00.000Z'),
};

/** Deps for a fully-populated interview; override any key per test. */
const detailDeps = (over = {}) => ({
  queryMeetings: async () => paged(1, [MEETING]),
  getMeetingById: async () => MEETING,
  resolveJobTitle: async () => 'QA Engineer',
  listRecordings: async () => [
    { id: 'r1', status: 'completed', durationMs: 2400000, playbackUrl: 'https://s3.test/rec.mp4?sig' },
  ],
  listEvaluations: async (ids) => new Map([[ids[0], [
    { evaluatorName: 'Vikram', evaluatorEmail: 'vik@x.test', weightedScore: 72, coveragePct: 100, isComplete: true, submittedAt: new Date(), comment: 'Solid on testing.' },
  ]]]),
  getInterviewSummary: async () => ({ summaryId: 's1', interviewId: 'm1', meetingId: 'meeting_abc', version: 2, executiveSummary: 'Candidate discussed test automation.', bulletSummary: ['a'], decisions: [{ text: 'next round' }], nextSteps: [], partial: false }),
  activityGate: denyGate,
  writeViewAudit: async () => {},
  ...over,
});

describe('interview tools (I) — fail closed', () => {
  for (const tool of [getInterview, getInterviewTranscript, listInterviews, countInterviews]) {
    it(`${tool.name} refuses to run without a user id`, async () => {
      const deps = { queryMeetings: () => assert.fail('called'), getMeetingById: () => assert.fail('called') };
      await assert.rejects(() => tool.execute({ candidate: 'x' }, { user: {}, deps }), /authenticated user/);
    });
  }
});

describe('interview tools (I) — access rules', () => {
  it('get_interview mirrors GET /meetings (interviews.read); meetings.read alone is not enough', async () => {
    assert.equal((await checkAccessRule(getInterview.access, viewer('interviews.read'))).ok, true);
    assert.equal((await checkAccessRule(getInterview.access, viewer('meetings.read'))).ok, false);
  });

  it('get_interview_transcript mirrors GET /meetings/:id/transcript (interviews.transcript.read and its aliases)', async () => {
    for (const p of ['interviews.transcript.read', 'ats.interviews.transcript:view']) {
      assert.equal((await checkAccessRule(getInterviewTranscript.access, viewer(p))).ok, true, p);
    }
    // The old recordings-route gate no longer opens it.
    for (const p of ['meetings.read', 'meetings.record', 'onboarding.edit', 'interviews.read']) {
      assert.equal((await checkAccessRule(getInterviewTranscript.access, viewer(p))).ok, false, p);
    }
  });

  it('transcript by candidate name also needs interviews.read (GET /meetings), checked before any lookup', async () => {
    const out = await getInterviewTranscript.execute(
      { candidate: 'Ravi' },
      ctxWith(detailDeps({ queryMeetings: () => assert.fail('must not look up') }), viewer('interviews.transcript.read')),
    );
    assert.match(out.error, /interviews\.read/);
  });

  it('transcript by id goes through the scoped lookup; out of scope (404) is notFound and writes no audit', async () => {
    const audits = [];
    const out = await getInterviewTranscript.execute({ id: 'mX' }, ctxWith(detailDeps({
      getMeetingById: async () => { throw notFound('Meeting not found'); },
      getInterviewTranscript: () => assert.fail('must not read'),
      writeViewAudit: async (_a, p) => { audits.push(p); },
    }), viewer('interviews.transcript.read')));
    assert.deepEqual(out, { notFound: true });
    assert.equal(audits.length, 0);
  });

  it('hides the AI summary without interviews.summary.read and never calls the summary service', async () => {
    const audits = [];
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({
      getInterviewSummary: () => assert.fail('must not read summary'),
      writeViewAudit: async (_a, p) => { audits.push(p.action); },
    })));
    assert.equal(out.aiSummary, null);
    assert.equal(out.aiSummaryHidden, true);
    assert.ok(!audits.includes('interview.summary.view'));
  });

  it('history is hidden without Activity Logs access, and never queried', async () => {
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({
      queryActivityLogs: () => assert.fail('must not query logs'),
    })));
    assert.equal(out.history, null);
    assert.equal(out.historyHidden, true);
  });
});

describe('get_interview', () => {
  it('passes the viewer to getMeetingById (meetingScope) and returns the full detail', async () => {
    let seenUser;
    const audits = [];
    const user = viewer('interviews.read', 'interviews.summary.read');
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({
      getMeetingById: async (_id, u) => { seenUser = u; return MEETING; },
      writeViewAudit: async (_a, p) => { audits.push(p); },
    }), user));
    assert.equal(seenUser, user);
    assert.equal(out.interview.jobPosition, 'QA Engineer');
    assert.equal(out.interview.scheduledBy, 'Asha Rao');
    assert.equal(out.interview.timezone, 'Asia/Kolkata');
    assert.deepEqual(out.interview.panel, [{ name: 'Asha Rao', role: 'recruiter' }, { name: 'Vikram', role: 'panel' }]);
    assert.deepEqual(out.attendance, [{ name: 'Ravi Kumar', role: 'candidate', firstJoinedAt: MEETING.participantRoster[0].firstJoinedAt }]);
    assert.equal(out.recording.recorded, true);
    assert.equal(out.recording.playbackUrl, 'https://s3.test/rec.mp4?sig');
    assert.equal(out.aiSummary.executiveSummary, 'Candidate discussed test automation.');
    assert.equal(out.evaluations[0].evaluator, 'Vikram');
    assert.equal(out.resultMissing, true);
    assert.equal(out.feedbackMissing, false);
    assert.doesNotMatch(JSON.stringify(out), /password|vik@x\.test|ravi@c\.test|"999"|emailHash|summaryId/);
    // Same rows as the portal controllers (getRecordings / getSummary), tagged as chat.
    const byAction = Object.fromEntries(audits.map((a) => [a.action, a]));
    assert.deepEqual(byAction['interview.recording.view'], {
      action: 'interview.recording.view', entityType: 'Meeting', entityId: 'm1', metadata: { recordingCount: 1, source: 'sage.chat' },
    });
    assert.deepEqual(byAction['interview.summary.view'], {
      action: 'interview.summary.view', entityType: 'Summary', entityId: 's1',
      metadata: { interviewId: 'm1', meetingId: 'meeting_abc', evaluationVersion: 2, source: 'sage.chat' },
    });
    assert.equal(getInterview.render(out).blocks[0].type, 'kv');
  });

  it('an audit write that throws or rejects never breaks the answer, and the answer never waits on it', async () => {
    for (const writeViewAudit of [
      () => { throw new Error('sync boom'); },
      async () => { throw new Error('async boom'); },
      () => new Promise(() => {}), // never settles
    ]) {
      const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({ writeViewAudit })));
      assert.equal(out.interview.id, 'm1');
    }
  });

  it('writes no recording audit when the interview has no recordings', async () => {
    const audits = [];
    await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({
      listRecordings: async () => [],
      writeViewAudit: async (_a, p) => { audits.push(p); },
    })));
    assert.equal(audits.length, 0);
  });

  it('scheduledOn comes from the ObjectId (the toJSON plugin strips createdAt from service results)', async () => {
    const { createdAt, ...stripped } = MEETING;
    const out = await getInterview.execute({ id: 'x' }, ctxWith(detailDeps({
      getMeetingById: async () => ({ ...stripped, id: '6ab2493e4563d8b8fa64e1e1' }),
    })));
    assert.ok(createdAt);
    assert.equal(out.interview.scheduledOn.toISOString(), new Date(0x6ab2493e * 1000).toISOString());
  });

  it('a job id that no longer resolves ("—", what resolveJobPositionDisplayTitle returns) is null, not "—"', async () => {
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({ resolveJobTitle: async () => '—' })));
    assert.equal(out.interview.jobPosition, null);
  });

  it('history: result changes + invitation re-sends from the Activity Logs page, graded to own rows when not full access', async () => {
    let seen;
    const out = await getInterview.execute({ id: 'm1' }, ctxWith(detailDeps({
      activityGate: allowGate,
      isDesignatedSuperadminEmail: () => false,
      resolveActivityLogListFilter: () => ({ actor: 'v1' }),
      queryActivityLogs: async (filter, options, u) => {
        seen = { filter, options, u };
        return {
          totalResults: 2,
          results: [
            { action: 'interview.result.update', actor: { name: 'Asha Rao' }, createdAt: '2026-09-29T06:00:00Z', metadata: { changes: [{ field: 'interviewResult', from: 'pending', to: 'selected' }] } },
            { action: 'interview.invitation.resend', actor: { name: 'Asha Rao' }, createdAt: '2026-09-28T06:00:00Z', metadata: {} },
          ],
        };
      },
    })));
    assert.equal(seen.filter.actor, 'v1');
    assert.equal(seen.filter.entityType, 'Meeting');
    assert.deepEqual(seen.filter.action, { $in: ['interview.result.update', 'interview.invitation.resend'] });
    assert.deepEqual(seen.filter.$or, [{ entityId: 'm1' }, { entityId: 'meeting_abc' }]);
    assert.equal(seen.u.id, 'v1');
    assert.equal(out.history.scope, 'your own actions only');
    assert.deepEqual(out.history.rows[0], { event: 'result changed', by: 'Asha Rao', at: '2026-09-29T06:00:00Z', from: 'pending', to: 'selected' });
    assert.equal(out.history.rows[1].event, 'invitations re-sent');
    assert.ok(!out.notCaptured.some((n) => /who set the result/.test(n)));
  });

  it('missing data comes back null / false, never invented', async () => {
    const bare = { id: 'm2', meetingId: 'meeting_x', status: 'ended', scheduledAt: MEETING.scheduledAt, candidate: { name: 'Meera' } };
    const out = await getInterview.execute({ id: 'm2' }, ctxWith(detailDeps({
      getMeetingById: async () => bare,
      resolveJobTitle: async () => '',
      listRecordings: async () => { throw notFound('Meeting not found'); },
      listEvaluations: async () => new Map(),
      getInterviewSummary: async () => { throw notFound('Summary not found'); },
    }), viewer('interviews.read', 'interviews.summary.read')));
    assert.equal(out.interview.jobPosition, null);
    assert.equal(out.interview.scheduledBy, null);
    assert.equal(out.interview.timezone, null);
    assert.equal(out.interview.result, null);
    assert.deepEqual(out.attendance, []);
    assert.equal(out.recording.recorded, false);
    assert.equal(out.recording.playbackUrl, null);
    assert.equal(out.aiSummary, null);
    assert.equal(out.aiSummaryHidden, undefined);
    assert.equal(out.legacyScorecard, null);
    assert.equal(out.resultMissing, true);
    assert.equal(out.feedbackMissing, true);
  });

  it('an id out of scope (404) is notFound', async () => {
    const out = await getInterview.execute({ id: 'mX' }, ctxWith(detailDeps({ getMeetingById: async () => { throw notFound(); } })));
    assert.deepEqual(out, { notFound: true });
    assert.equal(getInterview.render(out), null);
  });

  it('a candidate name with several rounds returns matches (job titles resolved) through the scoped page query', async () => {
    let seen;
    const out = await getInterview.execute({ candidate: 'Ravi', jobPosition: 'QA' }, ctxWith(detailDeps({
      queryMeetings: async (filter, options, user) => {
        seen = { filter, options, user };
        return paged(2, [MEETING, { ...MEETING, id: 'm0', round: { label: 'HR' } }]);
      },
      getMeetingById: () => assert.fail('must not load one'),
    })));
    assert.equal(seen.user.id, 'v1');
    assert.match(JSON.stringify(seen.filter), /"candidate.name"/);
    assert.match(JSON.stringify(seen.filter), /"jobPosition"/);
    assert.deepEqual(out.matches.map((m) => m.round), ['Technical', 'HR']);
    assert.deepEqual(out.matches.map((m) => m.jobPosition), ['QA Engineer', 'QA Engineer']);
  });
});

describe('get_interview_transcript', () => {
  // interviewTranscript.service getInterviewTranscript's real payload shape (sanitizeUtterance).
  const utterances = [
    { utteranceId: 'u1', displayName: 'Asha Rao', speakerRole: 'interviewer', text: 'Tell me about test automation.', recordingOffsetMs: 0, startedAtEpochMs: 1000, endedAtEpochMs: 5000 },
    { utteranceId: 'u2', displayName: 'Ravi Kumar', speakerRole: 'candidate', text: 'I built a Playwright suite.', recordingOffsetMs: 5000, startedAtEpochMs: 6000, endedAtEpochMs: 13000 },
  ];
  const payload = (over = {}) => ({
    meetingId: 'meeting_abc', interviewId: 'm1', version: 3, transcriptVersionId: 'tv1', utteranceCount: 2, partialReasons: [], utterances, ...over,
  });
  const transcriptDeps = (over = {}) => detailDeps({ getInterviewTranscript: async () => payload(), ...over });
  const user = viewer('interviews.read', 'interviews.transcript.read');

  it('reads the interview transcript service with the viewer, summarises, and writes the portal\'s audit row', async () => {
    let seen;
    const audits = [];
    const out = await getInterviewTranscript.execute({ id: 'm1' }, ctxWith(transcriptDeps({
      getInterviewTranscript: async (id, u) => { seen = { id, u }; return payload(); },
      writeViewAudit: async (_a, p) => { audits.push(p); },
    }), user));
    assert.deepEqual(seen, { id: 'm1', u: user });
    assert.equal(out.transcriptAvailable, true);
    assert.match(out.attribution, /not verified facts/);
    assert.deepEqual(out.speakers.map((s) => [s.name, s.role, s.spokenMs]), [['Asha Rao', 'interviewer', 4000], ['Ravi Kumar', 'candidate', 7000]]);
    assert.equal(out.windows.length, 1);
    assert.equal(out.windows[0].from, '0:00');
    assert.equal(out.windows[0].to, '0:12');
    assert.match(out.windows[0].excerpt, /Ravi Kumar: I built a Playwright suite/);
    assert.equal(out.fullText, undefined);
    assert.deepEqual(audits, [{
      action: 'interview.transcript.view', entityType: 'TranscriptVersion', entityId: 'tv1',
      metadata: { interviewId: 'm1', meetingId: 'meeting_abc', transcriptVersion: 3, source: 'sage.chat' },
    }]);
  });

  it('includeFullText adds the verbatim lines, capped at whole utterances', async () => {
    const out = await getInterviewTranscript.execute({ id: 'm1', includeFullText: true }, ctxWith(transcriptDeps(), user));
    assert.match(out.fullText, /\[0:05\] Ravi Kumar: I built a Playwright suite\./);
    assert.equal(out.truncated, false);

    const long = Array.from({ length: 400 }, (_, i) => ({ displayName: 'Ravi', text: 'x'.repeat(100), recordingOffsetMs: i * 1000 }));
    const big = await getInterviewTranscript.execute({ id: 'm1', includeFullText: true }, ctxWith(transcriptDeps({
      getInterviewTranscript: async () => payload({ utterances: long }),
    }), user));
    assert.ok(big.fullText.length <= MAX_FULL_TEXT_CHARS);
    assert.equal(big.truncated, true);
    assert.ok(big.windows.length <= 12);
  });

  it('a first utterance longer than the cap is cut, not dropped to an empty transcript', async () => {
    const huge = [{ displayName: 'Ravi', text: 'y'.repeat(MAX_FULL_TEXT_CHARS * 2), recordingOffsetMs: 0 }];
    const out = await getInterviewTranscript.execute({ id: 'm1', includeFullText: true }, ctxWith(transcriptDeps({
      getInterviewTranscript: async () => payload({ utterances: huge }),
    }), user));
    assert.ok(out.fullText.length > 1000 && out.fullText.length <= MAX_FULL_TEXT_CHARS);
    assert.equal(out.truncated, true);
  });

  it('no transcript (service 404) → reason from the recordings, and no audit row', async () => {
    const audits = [];
    const writeViewAudit = async (_a, p) => { audits.push(p); };
    const none = await getInterviewTranscript.execute({ id: 'm1' }, ctxWith(transcriptDeps({
      getInterviewTranscript: async () => { throw notFound('Transcript not found'); },
      listRecordings: async () => [],
      writeViewAudit,
    }), user));
    assert.equal(none.transcriptAvailable, false);
    assert.match(none.reason, /not recorded/);
    const pending = await getInterviewTranscript.execute({ id: 'm1' }, ctxWith(transcriptDeps({
      getInterviewTranscript: async () => { throw notFound('Transcript not found'); },
      writeViewAudit,
    }), user));
    assert.match(pending.reason, /recorded, but no transcript/);
    const unreadable = await getInterviewTranscript.execute({ id: 'm1' }, ctxWith(transcriptDeps({
      getInterviewTranscript: async () => payload({ utterances: [], utteranceCount: 9 }),
      writeViewAudit,
    }), user));
    assert.match(unreadable.reason, /could not be loaded/);
    assert.equal(audits.length, 0);
    assert.equal(getInterviewTranscript.render(none), null);
  });
});

describe('list_interviews / count_interviews — new filters', () => {
  const at = (iso, mins = 60) => ({ scheduledAt: new Date(iso), durationMinutes: mins });

  it('with no new keys the queryMeetings call is identical to HEAD (interviewMongoFilter, same options)', async () => {
    const filters = { candidate: 'Ravi', status: 'ended', result: 'selected', scheduledBetween: { from: '2026-09-01', to: '2026-09-30' } };
    const calls = [];
    const deps = { queryMeetings: async (f, o) => { calls.push([f, o]); return paged(0); }, resolveJobTitle: async () => '' };
    await listInterviews.execute({ filters, page: 2, limit: 10 }, ctxWith(deps));
    assert.deepEqual(calls, [[interviewMongoFilter(filters), { page: 2, limit: 10, sortBy: 'scheduledAt:desc' }]]);
    calls.length = 0;
    await countInterviews.execute({ filters }, ctxWith(deps));
    assert.deepEqual(calls[0], [interviewMongoFilter(filters), { limit: 1 }]);
  });

  it('list shows the job title, never the Job id stored in Meeting.jobPosition', async () => {
    const out = await listInterviews.execute({}, ctxWith({
      queryMeetings: async () => paged(2, [MEETING, { ...MEETING, id: 'm9', jobPosition: 'Data Analyst' }]),
      resolveJobTitle: async (id) => (id === MEETING.jobPosition ? 'QA Engineer' : assert.fail('only ids are looked up')),
    }));
    assert.deepEqual(out.records.map((r) => r.jobPosition), ['QA Engineer', 'Data Analyst']);
  });

  it('panelOverlaps pairs interviews that share a panel member (by id or email) and overlap in time', () => {
    const rows = [
      { id: 'a', candidate: { name: 'A' }, recruiter: { name: 'Asha', email: 'ASHA@x.test' }, ...at('2026-09-29T04:30:00Z') },
      { id: 'b', candidate: { name: 'B' }, agents: [{ name: 'Asha', email: 'asha@x.test' }], ...at('2026-09-29T05:00:00Z') },
      { id: 'c', candidate: { name: 'C' }, recruiter: { name: 'Neha', email: 'neha@x.test' }, ...at('2026-09-29T05:00:00Z') },
      { id: 'd', candidate: { name: 'D' }, recruiter: { name: 'Asha', email: 'asha@x.test' }, ...at('2026-09-29T05:30:00Z') },
    ];
    const o = panelOverlaps(rows);
    assert.deepEqual([...o.keys()].sort(), ['a', 'b', 'd']);
    assert.deepEqual(o.get('a').map((c) => c.interviewId), ['b']);
    assert.deepEqual(o.get('b').map((c) => c.interviewId).sort(), ['a', 'd']);
    assert.equal(o.get('a')[0].panelMember, 'Asha');
  });

  it('panelOverlaps: same user id with a changed email is one person; two people who only share a name are not', () => {
    const o = panelOverlaps([
      { id: 'a', recruiter: { id: 'u1', name: 'Asha', email: 'old@x.test' }, ...at('2026-09-29T05:00:00Z') },
      { id: 'b', agents: [{ id: 'u1', name: 'Asha R', email: 'new@x.test' }], ...at('2026-09-29T05:15:00Z') },
      { id: 'c', recruiter: { id: 'u9', name: 'Asha', email: 'other@x.test' }, ...at('2026-09-29T05:15:00Z') },
    ]);
    assert.deepEqual([...o.keys()].sort(), ['a', 'b']);
  });

  it('overlapping scans from MAX_DURATION_MIN before the window (scoped, cancelled left out), then lists only clashing rows', async () => {
    const calls = [];
    const rows = [
      // Starts the evening before (IST) and runs into the window.
      { id: 'early', candidate: { name: 'E' }, recruiter: { id: 'u1', name: 'Asha' }, ...at('2026-09-28T18:00:00Z', 120) },
      { id: 'b', candidate: { name: 'B' }, agents: [{ id: 'u1', name: 'Asha' }], ...at('2026-09-28T19:00:00Z') },
    ];
    const out = await listInterviews.execute(
      { filters: { overlapping: true, scheduledBetween: { from: '2026-09-29', to: '2026-09-29' } } },
      ctxWith({
        queryMeetings: async (filter, options, user) => {
          calls.push({ filter, options, user });
          return calls.length === 1 ? paged(2, rows) : paged(1, [rows[1]]);
        },
        resolveJobTitle: async () => '',
      }),
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.user.id === 'v1'));
    assert.equal(calls[0].options.limit, OVERLAP_SCAN_LIMIT);
    const scanWindow = calls[0].filter.$and[0].scheduledAt;
    // 2026-09-29 IST midnight = 2026-09-28T18:30Z, minus the longest allowed interview.
    assert.equal(scanWindow.$gte.toISOString(), new Date(Date.parse('2026-09-28T18:30:00.000Z') - MAX_DURATION_MIN * 60000).toISOString());
    assert.ok(calls[0].filter.$and.some((c) => c.status?.$not));
    assert.deepEqual(calls[1].filter.$and.at(-1), { _id: { $in: ['early', 'b'] } });
    // The listed query keeps the real window, so the early interview shows only as a conflict.
    assert.ok(JSON.stringify(calls[1].filter).includes('2026-09-28T18:30:00.000Z'));
    assert.equal(out.records[0].conflicts[0].interviewId, 'early');
  });

  it('overlapping needs a window and refuses an over-cap window', async () => {
    const deps = { queryMeetings: async () => paged(OVERLAP_SCAN_LIMIT + 1, []) };
    await assert.rejects(() => countInterviews.execute({ filters: { overlapping: true } }, ctxWith(deps)), /needs filters.scheduledBetween/);
    await assert.rejects(
      () => countInterviews.execute({ filters: { overlapping: true, scheduledBetween: { from: '2026-09-01', to: '2026-09-30' } } }, ctxWith(deps)),
      /Too many interviews/,
    );
  });

  it('resultMissing = ended + result pending on every bucket', async () => {
    const seen = [];
    const out = await countInterviews.execute(
      { filters: { resultMissing: true } },
      ctxWith({ queryMeetings: async (filter) => { seen.push(filter); return paged(3); } }),
    );
    assert.equal(seen.length, 1 + 3 + 3);
    assert.ok(seen.every((f) => /"interviewResult":\{"\$in":\["pending",null\]\}/.test(JSON.stringify(f))));
    assert.ok(seen.every((f) => String(f.$and.at(-2).$or[0].status.$regex) === '/^ended$/i'));
    assert.equal(out.total, 3);
  });

  it('count says how many rows have no result at all, so the result buckets add up to total', async () => {
    const counts = { selected: 5, rejected: 1, pending: 10 };
    const out = await countInterviews.execute({}, ctxWith({
      queryMeetings: async (filter) => {
        const r = JSON.stringify(filter).match(/"interviewResult":"(\w+)"/)?.[1];
        return paged(r ? counts[r] : 20);
      },
    }));
    assert.equal(out.resultNotSet, 4);
  });
});
