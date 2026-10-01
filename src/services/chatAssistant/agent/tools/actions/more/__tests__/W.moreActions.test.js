import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import allocateToProject, { ALLOCATE_ACCESS } from '../allocateToProject.tool.js';
import sendInterviewReminder, { REMINDER_ACCESS } from '../sendInterviewReminder.tool.js';
import decideLeaveRequest, { LEAVE_DECISION_ACCESS } from '../decideLeaveRequest.tool.js';
import { deliverInterviewReminder } from '../deliverInterviewReminder.js';
import { checkPrepared } from '../../../../sageActions.js';
import { checkAccessRule } from '../../../../../toolAccess.js';

const viewer = (...p) => ({ id: '64b7f0c2a1b2c3d4e5f60001', name: 'Asha', authContext: { permissions: new Set(p) } });
const PID = '64c000000000000000000001';
const MID = '64d000000000000000000001';
const RID = '64e000000000000000000001';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const FUTURE = new Date('2026-10-02T09:30:00.000Z');

const chain = (result) => {
  const c = { select: () => c, limit: () => c, populate: () => c, lean: async () => result };
  return c;
};

const EMPLOYEES = [
  { _id: 'e1', fullName: 'Priya Shah', employeeId: 'DBS1', owner: 'u1', email: 'priya@acme.test' },
  { _id: 'e2', fullName: 'Ravi Kumar', employeeId: 'DBS2', owner: 'u2', email: 'ravi@acme.test' },
  { _id: 'e3', fullName: 'No Login', employeeId: 'DBS3', owner: null, email: 'nologin@acme.test' },
];

function matchEmp(emp, filter) {
  if (filter.owner?.$in && !filter.owner.$in.map(String).includes(String(emp.owner))) return false;
  if (Object.prototype.hasOwnProperty.call(filter.owner || {}, '$ne') && String(emp.owner) === String(filter.owner.$ne)) return false;
  if (filter.$or) {
    return filter.$or.some((c) => {
      if (c.owner != null && String(c.owner) === String(emp.owner)) return true;
      if (c._id != null && String(c._id) === String(emp._id)) return true;
      if (c.fullName instanceof RegExp && c.fullName.test(emp.fullName || '')) return true;
      if (c.employeeId instanceof RegExp && c.employeeId.test(emp.employeeId || '')) return true;
      if (c.email instanceof RegExp && c.email.test(emp.email || '')) return true;
      return false;
    });
  }
  return true;
}

function employeeModel(extra = []) {
  const rows = [...EMPLOYEES, ...extra];
  return { find: (filter) => chain(rows.filter((e) => matchEmp(e, filter))) };
}

function projectOf(overrides = {}) {
  return { _id: PID, name: 'Apollo', status: 'Inprogress', assignedTo: [], ...overrides };
}

function allocateCtx(overrides = {}) {
  const updateProjectById = overrides.updateProjectById ?? mock.fn(async () => ({}));
  const countActiveProjects = overrides.countActiveProjects ?? mock.fn(async (ids) => new Map(ids.map((id) => [id, 0])));
  const deps = {
    Employee: overrides.Employee ?? employeeModel(),
    User: overrides.User ?? { findById: () => chain(null), find: () => chain([]) },
    Project: overrides.Project ?? { exists: async () => null },
    resolveProject: overrides.resolveProject ?? (async (text) => (
      text === 'Apollo' || text === PID ? { kind: 'found', project: projectOf(overrides.project) } : { kind: 'notFound' }
    )),
    resolveRowScope: overrides.resolveRowScope ?? (async () => null),
    countActiveProjects,
    getProjectById: overrides.getProjectById ?? (async () => projectOf(overrides.project)),
    updateProjectById,
  };
  return { ctx: { user: overrides.user ?? viewer('projects.manage'), deps }, updateProjectById, countActiveProjects };
}

describe('allocate_to_project', () => {
  it('drafts the people who will be added and keeps payload to ids', async () => {
    const { ctx, updateProjectById } = allocateCtx();
    const prepared = await allocateToProject.prepare({ people: ['Priya Shah', 'Ravi Kumar'], project: 'Apollo' }, ctx);
    assert.equal(checkPrepared(prepared, allocateToProject).ok, true);
    assert.equal(prepared.summary.targetCount, 2);
    assert.deepEqual(prepared.payload, { projectId: PID, userIds: ['u1', 'u2'] });
    assert.match(prepared.summary.lines[0], /Priya Shah and Ravi Kumar/);
    assert.match(prepared.summary.lines[1], /Project assigned/);
    assert.match(prepared.summary.lines[1], /No email/);
    assert.equal(updateProjectById.mock.calls.length, 0);
  });

  it('refuses, by name, anyone already on 2 other active projects', async () => {
    const { ctx } = allocateCtx({
      countActiveProjects: async (ids) => new Map(ids.map((id) => [id, id === 'u2' ? 2 : 1])),
    });
    const prepared = await allocateToProject.prepare({ people: ['Priya Shah', 'Ravi Kumar'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /Ravi Kumar is already on 2 other active projects/);
    assert.match(prepared.error, /limit is 2/);
    assert.equal(prepared.payload, undefined);
  });

  it('skips someone already on the project instead of applying the limit', async () => {
    const countActiveProjects = mock.fn(async () => new Map([['u1', 2]]));
    const { ctx } = allocateCtx({
      project: { assignedTo: [{ _id: 'u1' }] },
      countActiveProjects,
    });
    const prepared = await allocateToProject.prepare({ people: ['Priya Shah'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /Already on "Apollo": Priya Shah/);
    assert.equal(countActiveProjects.mock.calls.length, 0);
  });

  it('names people already on the project and drafts only the new ones', async () => {
    const { ctx } = allocateCtx({ project: { assignedTo: [{ _id: 'u1' }] } });
    const prepared = await allocateToProject.prepare({ people: ['Priya Shah', 'Ravi Kumar'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.payload.userIds, ['u2']);
    assert.match(prepared.summary.lines.join('\n'), /Skipped — already on "Apollo"/);
    assert.match(prepared.summary.lines.join('\n'), /Priya Shah/);
  });

  it('hides a person outside the Employees-page scope', async () => {
    const { ctx } = allocateCtx({ resolveRowScope: async () => new Set(['u1']) });
    const prepared = await allocateToProject.prepare({ people: ['Ravi Kumar'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /outside the employees you can see/);
    assert.doesNotMatch(prepared.error, /ravi@acme\.test|DBS2/);
    assert.equal(prepared.payload, undefined);
  });

  it('hides a project outside the Projects-page scope', async () => {
    const { ctx } = allocateCtx({
      resolveProject: async () => ({ kind: 'notFound' }),
      Project: { exists: async () => ({ _id: 'hidden' }) },
    });
    const prepared = await allocateToProject.prepare({ people: ['Priya Shah'], project: 'Secret' }, ctx);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error, '1 project is outside your scope.');
  });

  it('says when nobody matches', async () => {
    const { ctx } = allocateCtx();
    const prepared = await allocateToProject.prepare({ people: ['Nobody Here'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /No employee you can see matches "Nobody Here"/);
  });

  it('refuses a person with no login', async () => {
    const { ctx } = allocateCtx();
    const prepared = await allocateToProject.prepare({ people: ['No Login'], project: 'Apollo' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /no DharwinOne login/);
  });

  it('access is projects.manage (the assign route)', async () => {
    assert.deepEqual(ALLOCATE_ACCESS, { allOf: ['projects.manage'] });
    assert.equal((await checkAccessRule(ALLOCATE_ACCESS, viewer('projects.read'))).ok, false);
    assert.equal((await checkAccessRule(ALLOCATE_ACCESS, viewer('projects.manage'))).ok, true);
  });

  it('commit merges into the current roster and skips people already on it', async () => {
    const updateProjectById = mock.fn(async () => ({}));
    const { ctx } = allocateCtx({
      updateProjectById,
      getProjectById: async () => projectOf({ assignedTo: [{ _id: 'u0' }, { _id: 'u1' }] }),
    });
    const res = await allocateToProject.commit(
      { payload: { projectId: PID, userIds: ['u1', 'u2'] }, args: {} },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(updateProjectById.mock.calls[0].arguments[1], { assignedTo: ['u0', 'u1', 'u2'] });
    assert.deepEqual(res.details.alreadyAllocated, ['u1']);
    assert.deepEqual(res.details.addedUserIds, ['u2']);
  });

  it('commit says so when everyone is already allocated and does not write', async () => {
    const updateProjectById = mock.fn(async () => ({}));
    const { ctx } = allocateCtx({
      updateProjectById,
      getProjectById: async () => projectOf({ assignedTo: ['u1'] }),
    });
    const res = await allocateToProject.commit({ payload: { projectId: PID, userIds: ['u1'] }, args: {} }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.details.skipped, true);
    assert.match(res.message, /Already allocated/);
    assert.equal(updateProjectById.mock.calls.length, 0);
  });

  it('commit skips anyone who hit the limit after the draft', async () => {
    const updateProjectById = mock.fn(async () => ({}));
    const { ctx } = allocateCtx({
      updateProjectById,
      countActiveProjects: async () => new Map([['u2', 2]]),
    });
    const res = await allocateToProject.commit({ payload: { projectId: PID, userIds: ['u2'] }, args: {} }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.message, /Ravi Kumar/);
    assert.equal(updateProjectById.mock.calls.length, 0);
  });
});

function meeting(overrides = {}) {
  return {
    _id: MID,
    id: MID,
    meetingId: 'meeting_abc',
    title: 'QA screen',
    status: 'scheduled',
    scheduledAt: FUTURE,
    reminderSentAt: null,
    candidate: { name: 'Ravi Kumar', email: 'ravi@acme.test' },
    hosts: [{ nameOrRole: 'Asha Rao', email: 'asha@acme.test' }],
    recruiter: { name: 'Asha Rao', email: 'asha@acme.test' },
    agents: [],
    emailInvites: [],
    ...overrides,
  };
}

function reminderCtx(overrides = {}) {
  const m = meeting(overrides.meeting);
  const sendInterviewReminderFn = overrides.sendInterviewReminder ?? mock.fn(async () => ({ ok: true, delivered: 2, skipped: 0 }));
  const updateOne = overrides.updateOne ?? mock.fn(async () => ({ modifiedCount: 1 }));
  const deps = {
    getMeetingById: overrides.getMeetingById ?? (async () => m),
    queryMeetings: overrides.queryMeetings ?? (async () => ({ results: [m], totalResults: 1 })),
    resolveJobTitle: async () => 'QA Engineer',
    getInvitationEmails: overrides.getInvitationEmails,
    Meeting: { exists: overrides.exists ?? (async () => null), updateOne },
    now: () => NOW,
    sendInterviewReminder: sendInterviewReminderFn,
  };
  return {
    ctx: { user: overrides.user ?? viewer('interviews.read', 'interviews.manage'), deps },
    meeting: m,
    sendInterviewReminder: sendInterviewReminderFn,
    updateOne,
  };
}

describe('send_interview_reminder', () => {
  it('lists every recipient and keeps the payload to the interview id', async () => {
    const { ctx, sendInterviewReminder: send } = reminderCtx();
    const prepared = await sendInterviewReminder.prepare({ interview: MID }, ctx);
    assert.equal(checkPrepared(prepared, sendInterviewReminder).ok, true);
    assert.deepEqual(prepared.payload, { interviewId: MID });
    const text = prepared.summary.lines.join('\n');
    assert.match(text, /Ravi Kumar/);
    assert.match(text, /asha@acme\.test/);
    assert.match(text, /ravi@acme\.test/);
    assert.match(text, /Reminder: QA screen starts soon/);
    assert.match(text, /Interview reminder/);
    assert.equal(send.mock.calls.length, 0);
  });

  it('resolves a candidate name through the Interviews query', async () => {
    const { ctx } = reminderCtx();
    const prepared = await sendInterviewReminder.prepare({ interview: 'Ravi Kumar' }, ctx);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.interviewId, MID);
  });

  it('refuses a cancelled interview', async () => {
    const { ctx } = reminderCtx({ meeting: { status: 'cancelled' } });
    const prepared = await sendInterviewReminder.prepare({ interview: MID }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /cancelled/);
  });

  it('refuses an interview whose start time has passed', async () => {
    const { ctx } = reminderCtx({ meeting: { scheduledAt: new Date('2020-01-01T00:00:00.000Z') } });
    const prepared = await sendInterviewReminder.prepare({ interview: MID }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /already passed/);
  });

  it('hides an interview outside the Interviews-page scope', async () => {
    const err = new Error('not found');
    err.statusCode = 404;
    const { ctx } = reminderCtx({
      getMeetingById: async () => { throw err; },
      exists: async () => ({ _id: MID }),
    });
    const prepared = await sendInterviewReminder.prepare({ interview: MID }, ctx);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error, '1 interview is outside your scope.');
  });

  it('says when the interview does not exist', async () => {
    const err = new Error('not found');
    err.statusCode = 404;
    const { ctx } = reminderCtx({
      getMeetingById: async () => { throw err; },
      exists: async () => null,
    });
    const prepared = await sendInterviewReminder.prepare({ interview: MID }, ctx);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error, 'No interview found with that id.');
  });

  it('access is interviews.read AND interviews.manage', async () => {
    assert.deepEqual(REMINDER_ACCESS, { allOf: ['interviews.read', 'interviews.manage'] });
    assert.equal((await checkAccessRule(REMINDER_ACCESS, viewer('interviews.read'))).ok, false);
    assert.equal((await checkAccessRule(REMINDER_ACCESS, viewer('interviews.manage'))).ok, false);
    assert.equal((await checkAccessRule(REMINDER_ACCESS, viewer('interviews.read', 'interviews.manage'))).ok, true);
  });

  it('commit sends through the reminder path and stamps reminderSentAt', async () => {
    const { ctx, sendInterviewReminder: send, updateOne } = reminderCtx();
    const res = await sendInterviewReminder.commit({ payload: { interviewId: MID }, args: { interview: MID } }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.message, /Reminder sent to 2 recipients/);
    assert.equal(send.mock.calls.length, 1);
    assert.equal(String(updateOne.mock.calls[0].arguments[0]._id), MID);
    assert.equal(updateOne.mock.calls[0].arguments[0].reminderSentAt, null);
  });

  it('commit sends nothing when a reminder was already sent', async () => {
    const { ctx, sendInterviewReminder: send } = reminderCtx({ meeting: { reminderSentAt: new Date('2026-09-30T00:00:00.000Z') } });
    const res = await sendInterviewReminder.commit({ payload: { interviewId: MID }, args: {} }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.details.skipped, true);
    assert.match(res.message, /already sent/);
    assert.equal(send.mock.calls.length, 0);
  });
});

describe('deliverInterviewReminder', () => {
  it('uses the scheduler delivery: interviewT15 email plus in-app for a login', async () => {
    const notify = mock.fn(async () => {});
    const sendMeetingReminderEmail = mock.fn(async () => true);
    const seen = [];
    const dispatchReminder = async ({ kind, recipients, deliver }) => {
      seen.push({ kind, recipients });
      let delivered = 0;
      for (const recipient of recipients) {
        if (await deliver(recipient)) delivered += 1;
      }
      return { ok: true, delivered, skipped: recipients.length - delivered };
    };
    const res = await deliverInterviewReminder(meeting(), {
      notify,
      sendMeetingReminderEmail,
      dispatchReminder,
      getPublicMeetingUrl: () => 'https://example.test/join',
      getInAppMeetingLink: () => '/join/room?room=meeting_abc',
      User: { findOne: () => chain({ _id: 'login-1' }) },
    });
    assert.equal(res.ok, true);
    assert.equal(seen[0].kind, 'interviewT15');
    assert.equal(notify.mock.calls[0].arguments[1].type, 'meeting_reminder');
    assert.equal(notify.mock.calls[0].arguments[1].title, 'Interview reminder');
    assert.equal(sendMeetingReminderEmail.mock.calls[0].arguments[1].title, 'QA screen');
    assert.ok(res.delivered >= 1);
  });
});

function leaveRow(overrides = {}) {
  return {
    _id: RID,
    status: 'pending',
    leaveType: 'casual',
    dates: [new Date('2026-10-02T00:00:00.000Z'), new Date('2026-10-03T00:00:00.000Z')],
    studentEmail: 'priya@acme.test',
    student: { _id: 's1', user: { name: 'Priya Shah', email: 'priya@acme.test' } },
    ...overrides,
  };
}

function leaveCtx(overrides = {}) {
  const row = overrides.row === undefined ? leaveRow() : overrides.row;
  const findOne = mock.fn(() => chain(overrides.hidden ? null : row));
  const approveLeaveRequest = overrides.approveLeaveRequest ?? mock.fn(async () => ({}));
  const rejectLeaveRequest = overrides.rejectLeaveRequest ?? mock.fn(async () => ({}));
  const deps = {
    LeaveRequest: {
      findOne,
      find: () => chain(overrides.pending ?? (row ? [row] : [])),
      exists: async () => (overrides.exists ? { _id: RID } : null),
    },
    Employee: employeeModel(),
    Student: { find: () => chain([{ _id: 's1', user: 'u1' }]) },
    buildLeaveRequestScopeFilter: overrides.buildLeaveRequestScopeFilter ?? (async () => ({ filter: {} })),
    approveLeaveRequest,
    rejectLeaveRequest,
    isAdminOrAgent: overrides.isAdminOrAgent ?? (async () => true),
  };
  return {
    ctx: { user: overrides.user ?? viewer('students.manage'), deps },
    findOne,
    approveLeaveRequest,
    rejectLeaveRequest,
  };
}

describe('decide_leave_request', () => {
  it('shows the person, dates, type and decision, and the payload is the request id', async () => {
    const { ctx, approveLeaveRequest } = leaveCtx();
    const prepared = await decideLeaveRequest.prepare(
      { request: RID, decision: 'approve', comment: 'dates clash' },
      ctx,
    );
    assert.equal(checkPrepared(prepared, decideLeaveRequest).ok, true);
    assert.deepEqual(prepared.payload, { requestId: RID });
    const text = prepared.summary.lines.join('\n');
    assert.match(text, /Person: Priya Shah/);
    assert.match(text, /Dates: 2026-10-02, 2026-10-03/);
    assert.match(text, /Type: casual/);
    assert.match(text, /Decision: approve/);
    assert.match(text, /Leave request approved/);
    assert.match(text, /priya@acme\.test/);
    assert.doesNotMatch(JSON.stringify(prepared.payload), /dates clash|approve|Priya/);
    assert.equal(approveLeaveRequest.mock.calls.length, 0);
  });

  it('says not recorded when dates, type or name are missing', async () => {
    const { ctx } = leaveCtx({
      row: leaveRow({
        leaveType: null,
        dates: [],
        studentEmail: null,
        student: { user: { name: '  ' } },
      }),
    });
    const prepared = await decideLeaveRequest.prepare({ request: RID, decision: 'reject' }, ctx);
    assert.equal(prepared.ok, true);
    const text = prepared.summary.lines.join('\n');
    assert.match(text, /Person: not recorded/);
    assert.match(text, /Dates: not recorded/);
    assert.match(text, /Type: not recorded/);
    assert.match(text, /no student email/);
  });

  it('resolves one pending request from the person\'s name', async () => {
    const { ctx } = leaveCtx();
    const prepared = await decideLeaveRequest.prepare({ request: 'Priya Shah', decision: 'approve' }, ctx);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.requestId, RID);
    assert.match(prepared.summary.lines.join('\n'), /Person: Priya Shah/);
  });

  it('refuses a request that is not pending', async () => {
    const { ctx } = leaveCtx({ row: leaveRow({ status: 'approved' }) });
    const prepared = await decideLeaveRequest.prepare({ request: RID, decision: 'approve' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /already approved/);
  });

  it('hides a leave request outside the Leave Requests page scope', async () => {
    const { ctx } = leaveCtx({ hidden: true, exists: true });
    const prepared = await decideLeaveRequest.prepare({ request: RID, decision: 'reject' }, ctx);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error, '1 leave request is outside your scope.');
    assert.doesNotMatch(prepared.error, /Priya/);
  });

  it('refuses someone who is not an Administrator or Agent', async () => {
    const { ctx, findOne } = leaveCtx({ isAdminOrAgent: async () => false });
    const prepared = await decideLeaveRequest.prepare({ request: RID, decision: 'approve' }, ctx);
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /Administrator or Agent/);
    assert.equal(findOne.mock.calls.length, 0);
  });

  it('access is students.manage (the approve and reject routes)', async () => {
    assert.deepEqual(LEAVE_DECISION_ACCESS, { allOf: ['students.manage'] });
    assert.equal((await checkAccessRule(LEAVE_DECISION_ACCESS, viewer('students.read'))).ok, false);
    assert.equal((await checkAccessRule(LEAVE_DECISION_ACCESS, viewer('students.manage'))).ok, true);
  });

  it('commit calls approveLeaveRequest and passes the comment from the draft args', async () => {
    const { ctx, approveLeaveRequest } = leaveCtx();
    const res = await decideLeaveRequest.commit(
      { payload: { requestId: RID }, args: { decision: 'approve', comment: 'dates clash' } },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.match(res.message, /Approved/);
    assert.equal(approveLeaveRequest.mock.calls[0].arguments[0], RID);
    assert.equal(approveLeaveRequest.mock.calls[0].arguments[1], 'dates clash');
  });

  it('commit calls rejectLeaveRequest', async () => {
    const { ctx, rejectLeaveRequest, approveLeaveRequest } = leaveCtx();
    const res = await decideLeaveRequest.commit(
      { payload: { requestId: RID }, args: { decision: 'reject' } },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(rejectLeaveRequest.mock.calls.length, 1);
    assert.equal(rejectLeaveRequest.mock.calls[0].arguments[1], null);
    assert.equal(approveLeaveRequest.mock.calls.length, 0);
  });

  it('commit says so when the request was already decided and does not write', async () => {
    const { ctx, approveLeaveRequest } = leaveCtx({ row: leaveRow({ status: 'rejected' }) });
    const res = await decideLeaveRequest.commit(
      { payload: { requestId: RID }, args: { decision: 'approve' } },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(res.details.skipped, true);
    assert.match(res.message, /Already rejected/);
    assert.equal(approveLeaveRequest.mock.calls.length, 0);
  });
});
