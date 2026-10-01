import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import resendInterviewInvite from '../resendInterviewInvite.tool.js';
import sendInterviewBookingLink from '../sendInterviewBookingLink.tool.js';
import scheduleInterview from '../scheduleInterview.tool.js';
import domain from '../index.js';
import { sageAuditReq } from '../common.js';
import { checkAccessRule } from '../../../../../toolAccess.js';
import { checkPrepared, STALE_MESSAGE } from '../../../../sageActions.js';
import { buildAtsMetadataBase } from '../../../../../../../utils/atsAudit.helpers.js';
import { ActivityActions, EntityTypes } from '../../../../../../../config/activityLog.js';

const NOW = new Date('2026-09-30T06:00:00.000Z');
const APP_ID = '64a000000000000000000001';
const JOB_ID = '64b000000000000000000001';
const CAND_ID = '64c000000000000000000001';
const MEETING_ID = '64d000000000000000000001';
const VIEWER_ID = '64e000000000000000000001';
const HOST_ID = '64e000000000000000000002';

const viewer = (...perms) => ({
  id: VIEWER_ID, _id: VIEWER_ID, name: 'Asha Rao', email: 'asha@acme.com',
  authContext: { permissions: new Set(perms) },
});
const MANAGER = viewer('interviews.read', 'interviews.manage');

/** A Mongoose-style chain: .select().lean() resolves to `value`. */
const chain = (value) => {
  const q = { select: () => q, lean: async () => value };
  return q;
};
const byId = (rows) => (id) => chain(rows[String(id)] ?? null);

const APP = { _id: APP_ID, job: JOB_ID, candidate: CAND_ID, status: 'Applied' };
const JOB = { _id: JOB_ID, title: 'QA Engineer', status: 'Active', interviewerPool: [HOST_ID] };
const CANDIDATE = { _id: CAND_ID, fullName: 'Ravi Kumar', email: 'ravi@mail.com', phoneNumber: '999', isActive: true };
const USERS = {
  [VIEWER_ID]: { _id: VIEWER_ID, name: 'Asha Rao', email: 'asha@acme.com', status: 'active' },
  [HOST_ID]: { _id: HOST_ID, name: 'Vikram Shah', email: 'vik@acme.com', status: 'active' },
};

const MEETING = {
  id: MEETING_ID, meetingId: 'meeting_abc123', title: 'Interview: Ravi Kumar — QA Engineer', status: 'scheduled',
  scheduledAt: new Date('2026-10-02T09:30:00.000Z'), jobPosition: JOB_ID,
  hosts: [{ nameOrRole: 'Vikram Shah', email: 'Vik@acme.com' }],
  emailInvites: ['guest@outside.com'],
  candidate: { id: CAND_ID, name: 'Ravi Kumar', email: 'ravi@mail.com' },
  recruiter: { id: VIEWER_ID, name: 'Asha Rao', email: 'asha@acme.com' },
  agents: [{ id: HOST_ID, name: 'Vikram Shah', email: 'vik@acme.com' }, { id: 'p2', name: 'Meera Nair', email: 'meera@acme.com' }],
};

/**
 * Every dependency the tools reach, mocked. A test overrides keys; nothing falls through to a real
 * model or service, so no Mongo read/write and no email / notification can happen.
 */
function makeDeps(over = {}) {
  const apps = { [APP_ID]: APP };
  return {
    now: () => NOW,
    buildApplicantQuery: mock.fn(async () => ({ query: { scoped: true } })),
    JobApplication: {
      findOne: mock.fn((filter) => chain(filter.$and?.[0]?.scoped ? apps[String(filter.$and[1]._id)] ?? null : null)),
      exists: mock.fn(async () => true),
    },
    Job: { findById: byId({ [JOB_ID]: JOB }) },
    Employee: { findById: byId({ [CAND_ID]: CANDIDATE }) },
    User: {
      findById: byId(USERS),
      findOne: ({ email }) => chain(Object.values(USERS).find((u) => u.email === email) ?? null),
    },
    Meeting: { exists: mock.fn(async () => false) },
    ActivityLog: { exists: mock.fn(async () => false) },
    getMeetingById: mock.fn(async () => MEETING),
    queryMeetings: mock.fn(async () => ({ totalResults: 0, results: [] })),
    resolveJobTitle: async () => 'QA Engineer',
    resendMeetingInvitations: mock.fn(async () => ({ sent: 5 })),
    createMeeting: mock.fn(async (body) => ({ id: 'new-meeting', ...body })),
    sendBookingLinkEmail: mock.fn(async () => true),
    writeAtsAudit: mock.fn(async () => null),
    ...over,
  };
}
const ctxWith = (deps, user = MANAGER) => ({ user, requestId: 'req-1', deps });

/** The draft sageActions stores: args validated by the tool's Joi schema, summary + payload from prepare. */
async function draftFor(tool, args, deps) {
  const { value, error } = tool.input.validate(args);
  assert.equal(error, undefined);
  const prepared = await tool.prepare(value, ctxWith(deps));
  assert.equal(prepared.ok, true, prepared.error);
  const checked = checkPrepared(prepared, tool);
  assert.equal(checked.ok, true, checked.error);
  return { key: 'key-1', tool: tool.name, args: value, summary: checked.summary, payload: checked.payload };
}

describe('interview actions (I) — definitions', () => {
  it('registers three write tools with prepare/commit/recheck and a domain summary', () => {
    assert.equal(domain.domain, 'interview_actions');
    assert.ok(domain.summary.length <= 120);
    for (const t of domain.tools) {
      assert.equal(t.kind, 'write');
      assert.equal(typeof t.prepare, 'function');
      assert.equal(typeof t.commit, 'function');
      assert.equal(typeof t.recheck, 'function');
      assert.equal(t.maxTargets, 1);
    }
  });

  for (const tool of [resendInterviewInvite, sendInterviewBookingLink, scheduleInterview]) {
    it(`${tool.name} refuses to prepare without a user id`, async () => {
      const deps = makeDeps();
      await assert.rejects(() => tool.prepare({ interview: 'x', application: APP_ID, scheduledAt: '2026-10-02T15:00:00+05:30' }, { user: {}, deps }), /authenticated user/);
      assert.equal(deps.buildApplicantQuery.mock.callCount(), 0);
      assert.equal(deps.getMeetingById.mock.callCount(), 0);
    });
  }
});

describe('interview actions (I) — access', () => {
  it('resend needs interviews.manage AND interviews.read (the service scopes by meetingScope read)', async () => {
    assert.equal((await checkAccessRule(resendInterviewInvite.access, MANAGER)).ok, true);
    assert.equal((await checkAccessRule(resendInterviewInvite.access, viewer('interviews.manage'))).ok, false);
    assert.equal((await checkAccessRule(resendInterviewInvite.access, viewer('interviews.read'))).ok, false);
  });

  it('schedule and booking link mirror POST /meetings (interviews.manage); read alone is denied', async () => {
    for (const tool of [scheduleInterview, sendInterviewBookingLink]) {
      assert.equal((await checkAccessRule(tool.access, viewer('interviews.manage'))).ok, true, tool.name);
      assert.equal((await checkAccessRule(tool.access, viewer('interviews.read'))).ok, false, tool.name);
      assert.equal((await checkAccessRule(tool.access, viewer('candidates.manage'))).ok, false, tool.name);
    }
  });
});

// ─── resend_interview_invite ────────────────────────────────────────────────

describe('resend_interview_invite', () => {
  it('prepare lists EVERY address getInvitationEmails returns (hosts, invites, candidate, recruiter, panel) with the count', async () => {
    const deps = makeDeps();
    const draft = await draftFor(resendInterviewInvite, { interview: MEETING_ID }, deps);
    const lines = draft.summary.lines.join('\n');
    assert.match(lines, /Recipients \(5\):/);
    for (const email of ['vik@acme.com', 'guest@outside.com', 'ravi@mail.com', 'asha@acme.com', 'meera@acme.com']) {
      assert.ok(lines.includes(email), email);
    }
    assert.match(lines, /Vikram Shah \(host, panel\) — vik@acme\.com/);
    assert.match(lines, /\(invited\) — guest@outside\.com/);
    assert.match(lines, /Ravi Kumar \(candidate\)/);
    assert.match(lines, /in-app notification/);
    assert.match(lines, /Meeting invitation: Interview: Ravi Kumar — QA Engineer/);
    assert.match(lines, /\(IST\)/);
    assert.deepEqual(draft.payload, { interviewId: MEETING_ID });
    assert.deepEqual(draft.summary.targets, [{ id: MEETING_ID, name: 'Ravi Kumar — QA Engineer' }]);
    assert.equal(deps.getMeetingById.mock.calls[0].arguments[1], MANAGER, 'resolved through getMeetingById with the viewer (meetingScope)');
  });

  it('refuses a cancelled interview in prepare', async () => {
    const deps = makeDeps({ getMeetingById: async () => ({ ...MEETING, status: 'cancelled' }) });
    const res = await resendInterviewInvite.prepare({ interview: MEETING_ID }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /cancelled/);
  });

  it('an interview outside the viewer\'s meetingScope is refused by count only', async () => {
    const deps = makeDeps({
      getMeetingById: async () => { throw Object.assign(new Error('Meeting not found'), { statusCode: 404 }); },
      Meeting: { exists: async () => true },
    });
    const res = await resendInterviewInvite.prepare({ interview: MEETING_ID }, ctxWith(deps));
    assert.deepEqual(res, { ok: false, error: '1 interview is outside your scope.' });
  });

  it('refuses more than 50 recipients', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `g${i}@outside.com`);
    const deps = makeDeps({ getMeetingById: async () => ({ ...MEETING, emailInvites: many, hosts: [], agents: [], candidate: {}, recruiter: {} }) });
    const res = await resendInterviewInvite.prepare({ interview: MEETING_ID }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /51 addresses; at most 50/);
  });

  it('refuses when there is no one to invite', async () => {
    const deps = makeDeps({ getMeetingById: async () => ({ ...MEETING, emailInvites: [], hosts: [], agents: [], candidate: {}, recruiter: {} }) });
    const res = await resendInterviewInvite.prepare({ interview: MEETING_ID }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /no one to invite/);
  });

  it('a name matching several interviews asks which one, sending nothing', async () => {
    const deps = makeDeps({
      queryMeetings: async () => ({ totalResults: 2, results: [MEETING, { ...MEETING, id: 'm2', scheduledAt: new Date('2026-10-03T09:30:00Z') }] }),
    });
    const res = await resendInterviewInvite.prepare({ interview: 'Ravi' }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /2 interviews match "Ravi"/);
    assert.equal(deps.resendMeetingInvitations.mock.callCount(), 0);
  });

  it('commit calls resendMeetingInvitations with exactly the payload id and writes the controller\'s audit as ats/sage', async () => {
    const deps = makeDeps();
    const draft = await draftFor(resendInterviewInvite, { interview: MEETING_ID }, deps);
    const res = await resendInterviewInvite.commit(draft, ctxWith(deps));
    assert.equal(res.ok, true);
    assert.equal(deps.resendMeetingInvitations.mock.callCount(), 1);
    assert.deepEqual(deps.resendMeetingInvitations.mock.calls[0].arguments, [MEETING_ID, MANAGER]);

    assert.equal(deps.writeAtsAudit.mock.callCount(), 1);
    const [actor, params, req, options] = deps.writeAtsAudit.mock.calls[0].arguments;
    assert.equal(actor, VIEWER_ID);
    assert.equal(params.action, ActivityActions.INTERVIEW_INVITATION_RESEND);
    assert.equal(params.entityType, EntityTypes.MEETING);
    assert.equal(params.entityId, MEETING_ID);
    assert.deepEqual(options, { editContext: { staffEdit: true } });
    // The real metadata builder turns the stand-in request into source ats/sage (not 'system').
    const meta = buildAtsMetadataBase(req, params.metadata);
    assert.equal(meta.source, 'ats/sage');
    assert.equal(meta.requestId, 'req-1');
  });

  it('commit is safe on replay: a confirmation already audited sends nothing again', async () => {
    const deps = makeDeps({ ActivityLog: { exists: mock.fn(async () => true) } });
    const draft = { key: 'key-1', args: { interview: MEETING_ID }, summary: {}, payload: { interviewId: MEETING_ID } };
    const res = await resendInterviewInvite.commit(draft, ctxWith(deps));
    assert.equal(res.ok, true);
    assert.equal(res.details.skipped, true);
    assert.equal(deps.resendMeetingInvitations.mock.callCount(), 0);
    assert.equal(deps.writeAtsAudit.mock.callCount(), 0);
    assert.deepEqual(deps.ActivityLog.exists.mock.calls[0].arguments[0], {
      action: ActivityActions.INTERVIEW_INVITATION_RESEND, entityType: EntityTypes.MEETING, entityId: MEETING_ID, 'metadata.sageAction': 'key-1',
    });
  });

  it('recheck refuses when the recipient list changed since the draft', async () => {
    const deps = makeDeps();
    const draft = await draftFor(resendInterviewInvite, { interview: MEETING_ID }, deps);
    const changed = makeDeps({ getMeetingById: async () => ({ ...MEETING, emailInvites: ['someone.new@outside.com'] }) });
    assert.deepEqual(await resendInterviewInvite.recheck(draft, ctxWith(changed)), { ok: false, error: STALE_MESSAGE });
    assert.deepEqual(await resendInterviewInvite.recheck(draft, ctxWith(makeDeps())), { ok: true });
  });

  it('the audit source helper uses the ats/ prefix the allowlist accepts', () => {
    assert.equal(sageAuditReq({ requestId: 'r9' }).headers['x-audit-source'], 'ats/sage');
  });
});

// ─── send_interview_booking_link ────────────────────────────────────────────

describe('send_interview_booking_link', () => {
  it('prepare names the recipient, channel and the exact message; payload is the application id only', async () => {
    const deps = makeDeps();
    const draft = await draftFor(sendInterviewBookingLink, { application: APP_ID }, deps);
    const lines = draft.summary.lines.join('\n');
    assert.match(lines, /To: Ravi Kumar — ravi@mail\.com \(the candidate profile's own email\)/);
    assert.match(lines, /email only \(no in-app notification\)/);
    assert.match(lines, /Subject: "Choose your interview time — QA Engineer"/);
    assert.match(lines, /Hi Ravi Kumar, Thanks for your interest in QA Engineer/);
    assert.deepEqual(draft.payload, { applicationId: APP_ID });
    assert.deepEqual(draft.summary.targets, [{ id: APP_ID, name: 'Ravi Kumar — QA Engineer' }]);
    const [filter, user] = deps.buildApplicantQuery.mock.calls[0].arguments;
    assert.equal(filter.excludeInternal, true);
    assert.equal(user, MANAGER);
  });

  it('refuses a candidate with no email (the service would silently send nothing)', async () => {
    const deps = makeDeps({ Employee: { findById: () => chain({ ...CANDIDATE, email: '' }) } });
    const res = await sendInterviewBookingLink.prepare({ application: APP_ID }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /no email address/);
  });

  it('an application outside list_applications\' scope is refused by count only', async () => {
    const deps = makeDeps({ buildApplicantQuery: async () => ({ query: { scoped: false } }) });
    const res = await sendInterviewBookingLink.prepare({ application: APP_ID }, ctxWith(deps));
    assert.deepEqual(res, { ok: false, error: '1 application is outside your scope.' });
  });

  it('a missing application says so', async () => {
    const deps = makeDeps({ JobApplication: { findOne: () => chain(null), exists: async () => false } });
    const res = await sendInterviewBookingLink.prepare({ application: APP_ID }, ctxWith(deps));
    assert.deepEqual(res, { ok: false, error: 'No application found with that id.' });
  });

  it('refuses an application that can no longer be scheduled', async () => {
    const deps = makeDeps({ JobApplication: { findOne: () => chain({ ...APP, status: 'Rejected' }), exists: async () => true } });
    const res = await sendInterviewBookingLink.prepare({ application: APP_ID }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /rejected application/);
  });

  it('only ever targets one application: a list of ids is rejected by the input schema', () => {
    assert.ok(sendInterviewBookingLink.input.validate({ application: [APP_ID, APP_ID] }).error);
    assert.equal(sendInterviewBookingLink.maxTargets, 1);
  });

  it('commit calls sendBookingLinkEmail with exactly the payload id and writes no ATS audit', async () => {
    const deps = makeDeps();
    const draft = await draftFor(sendInterviewBookingLink, { application: APP_ID }, deps);
    const res = await sendInterviewBookingLink.commit(draft, ctxWith(deps));
    assert.deepEqual(res, { ok: true, message: 'Booking link emailed to Ravi Kumar — QA Engineer.', details: { sent: true } });
    assert.deepEqual(deps.sendBookingLinkEmail.mock.calls[0].arguments, [APP_ID]);
    assert.equal(deps.writeAtsAudit.mock.callCount(), 0);
  });

  it('commit reports failure when the service sent nothing', async () => {
    const deps = makeDeps({ sendBookingLinkEmail: mock.fn(async () => false) });
    const draft = await draftFor(sendInterviewBookingLink, { application: APP_ID }, deps);
    const res = await sendInterviewBookingLink.commit(draft, ctxWith(deps));
    assert.equal(res.ok, false);
  });

  it('commit is safe on replay: a key already confirmed sends nothing again', async () => {
    const deps = makeDeps({ ActivityLog: { exists: mock.fn(async () => true) } });
    const res = await sendInterviewBookingLink.commit({ key: 'key-1', summary: {}, payload: { applicationId: APP_ID } }, ctxWith(deps));
    assert.equal(res.details.skipped, true);
    assert.equal(deps.sendBookingLinkEmail.mock.callCount(), 0);
    assert.deepEqual(deps.ActivityLog.exists.mock.calls[0].arguments[0], {
      action: ActivityActions.SAGE_ACTION_CONFIRMED, entityType: EntityTypes.SAGE_ACTION, entityId: 'key-1',
    });
  });
});

// ─── schedule_interview ─────────────────────────────────────────────────────

const AT = '2026-10-02T15:00:00+05:30';

describe('schedule_interview', () => {
  it('prepare: hosts default to the caller; summary shows IST, the Interview move and every invitee', async () => {
    const deps = makeDeps();
    const draft = await draftFor(scheduleInterview, { application: APP_ID, scheduledAt: AT }, deps);
    const lines = draft.summary.lines.join('\n');
    assert.match(lines, /When: Friday 2 October, 3 PM India time \(IST\) · 60 min · Video/);
    assert.match(lines, /Moves the application from Applied to Interview\./);
    assert.match(lines, /every invitee gets an invitation email/);
    assert.match(lines, /Invitees \(2\):/);
    assert.match(lines, /Asha Rao \(host, recruiter, panel\) — asha@acme\.com/);
    assert.match(lines, /Ravi Kumar \(candidate\) — ravi@mail\.com/);
    assert.match(lines, /reminder email 10 minutes before/);
    assert.match(lines, /No clashes found/);
    assert.deepEqual(draft.payload, { applicationId: APP_ID, hostUserIds: [VIEWER_ID] });
  });

  it('proves the application is in the caller\'s scope before anything else (createMeeting has no scope check)', async () => {
    const deps = makeDeps({ buildApplicantQuery: mock.fn(async () => ({ query: { scoped: false } })) });
    const res = await scheduleInterview.prepare(
      scheduleInterview.input.validate({ application: APP_ID, scheduledAt: AT }).value, ctxWith(deps));
    assert.deepEqual(res, { ok: false, error: '1 application is outside your scope.' });
    assert.equal(deps.buildApplicantQuery.mock.calls[0].arguments[1], MANAGER);
    assert.equal(deps.createMeeting.mock.callCount(), 0);
  });

  it('refuses a start time that is not in the future', async () => {
    const deps = makeDeps();
    const res = await scheduleInterview.prepare({ application: APP_ID, scheduledAt: '2026-09-30T11:00:00+05:30', durationMinutes: 60, interviewType: 'Video' }, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /must be in the future/);
  });

  it('refuses a time without an explicit offset and the route\'s own limits (duration > 480)', () => {
    assert.ok(scheduleInterview.input.validate({ application: APP_ID, scheduledAt: '2026-10-02T15:00' }).error);
    assert.ok(scheduleInterview.input.validate({ application: APP_ID, scheduledAt: AT, durationMinutes: 600 }).error);
  });

  it('refuses more than 10 hosts and unknown host emails (no mailing arbitrary addresses)', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `h${i}@acme.com`);
    assert.ok(scheduleInterview.input.validate({ application: APP_ID, scheduledAt: AT, hosts: eleven }).error);
    const deps = makeDeps();
    const args = scheduleInterview.input.validate({ application: APP_ID, scheduledAt: AT, hosts: ['stranger@outside.com'] }).value;
    const res = await scheduleInterview.prepare(args, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /No active DharwinOne user matches host "stranger@outside\.com"/);
  });

  it('warns about a panel clash from list_interviews\' overlap rule', async () => {
    const other = {
      id: 'other', candidate: { name: 'Meera Nair' }, scheduledAt: new Date('2026-10-02T09:00:00.000Z'), durationMinutes: 60,
      recruiter: { id: 'someone', name: 'Someone' }, agents: [{ id: HOST_ID, name: 'Vikram Shah', email: 'vik@acme.com' }],
    };
    const deps = makeDeps({ queryMeetings: mock.fn(async () => ({ totalResults: 1, results: [other] })) });
    const draft = await draftFor(scheduleInterview, { application: APP_ID, scheduledAt: AT, hosts: [HOST_ID] }, deps);
    assert.match(draft.summary.lines.join('\n'), /Warning — clash: Vikram Shah already has an interview with Meera Nair/);
    assert.equal(deps.queryMeetings.mock.calls[0].arguments[2], MANAGER, 'clash scan runs under the viewer\'s meetingScope');
  });

  it('refuses when the application already has an interview at that exact time', async () => {
    const deps = makeDeps({ Meeting: { exists: async () => true } });
    const res = await scheduleInterview.prepare(
      scheduleInterview.input.validate({ application: APP_ID, scheduledAt: AT }).value, ctxWith(deps));
    assert.equal(res.ok, false);
    assert.match(res.error, /already has an interview/);
  });

  it('commit calls createMeeting once with a route-valid body built from exactly the payload ids', async () => {
    const deps = makeDeps();
    const draft = await draftFor(scheduleInterview, { application: APP_ID, scheduledAt: AT, hosts: ['vik@acme.com'] }, deps);
    const res = await scheduleInterview.commit(draft, ctxWith(deps));
    assert.equal(res.ok, true);
    assert.equal(deps.createMeeting.mock.callCount(), 1);
    const [body, userId] = deps.createMeeting.mock.calls[0].arguments;
    assert.equal(userId, VIEWER_ID);
    assert.equal(body.applicationId, draft.payload.applicationId);
    assert.deepEqual(body.agents.map((a) => a.id), draft.payload.hostUserIds);
    assert.deepEqual(body.hosts, [{ nameOrRole: 'Vikram Shah', email: 'vik@acme.com' }]);
    assert.equal(body.scheduledAt.toISOString(), '2026-10-02T09:30:00.000Z');
    assert.equal(body.timezone, 'Asia/Kolkata');
    assert.deepEqual(body.emailInvites, [], 'route defaults applied by the createMeeting Joi schema');
  });

  it('commit is safe on replay: an interview already at that slot is not created twice', async () => {
    const deps = makeDeps();
    const draft = await draftFor(scheduleInterview, { application: APP_ID, scheduledAt: AT }, deps);
    const replayDeps = makeDeps({ Meeting: { exists: async () => true } });
    const res = await scheduleInterview.commit(draft, ctxWith(replayDeps));
    assert.equal(res.ok, true);
    assert.equal(res.details.skipped, true);
    assert.equal(replayDeps.createMeeting.mock.callCount(), 0);
  });

  it('recheck refuses when a clash appeared since the draft', async () => {
    const deps = makeDeps();
    const draft = await draftFor(scheduleInterview, { application: APP_ID, scheduledAt: AT }, deps);
    const clash = {
      id: 'late', candidate: { name: 'Meera Nair' }, scheduledAt: new Date('2026-10-02T09:30:00.000Z'), durationMinutes: 30,
      recruiter: { id: VIEWER_ID, name: 'Asha Rao', email: 'asha@acme.com' }, agents: [],
    };
    const later = makeDeps({ queryMeetings: async () => ({ totalResults: 1, results: [clash] }) });
    assert.deepEqual(await scheduleInterview.recheck(draft, ctxWith(later)), { ok: false, error: STALE_MESSAGE });
  });
});
