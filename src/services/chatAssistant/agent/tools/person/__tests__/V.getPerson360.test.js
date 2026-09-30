import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import getPerson360, { SECTIONS } from '../getPerson360.tool.js';

const NOW = new Date('2026-09-30T20:00:00Z'); // 01:30 IST on 2026-10-01
const IST_TODAY = '2026-10-01';
const U1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const ok = (result) => ({ status: 'ok', result });
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function uniqueUser(roleSlugs, { userId = U1, name = 'Priya Sharma', email = 'priya@x.com', profiles } = {}) {
  return ok({
    kind: 'unique',
    identity: { userId, name, email, roles: roleSlugs.map(cap), roleSlugs },
    roles: roleSlugs.map((slug) => ({ name: cap(slug), slug, aliases: [], status: 'active', permissions: [] })),
    profiles: profiles ?? {
      employee: {
        fields: { employeeId: 'E1', designation: 'Dev', department: 'Eng', joiningDate: '2026-01-05', salary: 99 },
        redacted: ['department'],
      },
    },
    availableSections: [],
  });
}

const task = (i, status = 'todo', project = 'Apollo') => ({
  id: `t${i}`, code: `T-${i}`, title: `Task ${i}`, status, priority: 'medium', dueDate: '2026-10-01', project, assignees: ['Priya Sharma'],
});

/** Every section tool answering with data for Priya Sharma. */
function goodResponses() {
  return {
    get_referral: ok({ total: 1, records: [{ candidate: 'Priya Sharma', email: 'priya@x.com', referredBy: 'Amit', salesAgent: null, channel: 'link', job: 'Dev', referredAt: '2026-01-01', status: 'Applied' }] }),
    list_applications: ok({ total: 7, records: Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, applicant: 'Priya Sharma', job: `Job ${i}`, status: 'Applied', appliedAt: '2026-02-01' })) }),
    list_call_records: ok({ total: 2, records: [{ id: 'c1', when: '2026-09-01', person: 'Priya Sharma', callType: 'screening', status: 'completed', durationSeconds: 60, outcome: null, phone: '999' }] }),
    get_call_metrics: ok({ totalCalls: 2, answeredCalls: 1, answerRate: 50, avgDurationSeconds: 30, failedCalls: 1, applicantsTotal: 900 }),
    list_interviews: ok({
      total: 3,
      records: [
        { id: 'i1', candidate: 'Priya Sharma', jobPosition: 'Dev', interviewers: ['Ravi'], scheduledAt: '2026-09-10', status: 'completed', result: null },
        { id: 'i2', candidate: 'Priya Sharmaji', jobPosition: 'QA', interviewers: ['Ravi'], scheduledAt: '2026-09-11', status: 'scheduled', result: null },
        { id: 'i3', candidate: ' priya  sharma ', jobPosition: 'Ops', interviewers: [], scheduledAt: '2026-09-12', status: 'completed', result: 'selected' },
      ],
    }),
    get_offer: ok({ offerCode: 'OF-1', candidate: 'Priya Sharma', job: 'Dev', status: 'Sent', sentAt: '2026-09-01', daysPending: 3, compensation: { ctc: 100 } }),
    get_placement: ok({ candidate: 'Priya Sharma', status: 'Pending', job: 'Dev', joiningDate: '2026-10-15', firstBlockingStep: 'Background check', holdsEmployeeRole: false, steps: [{}] }),
    list_documents: ok({ candidateId: 'e1', name: 'Priya Sharma', counts: { uploaded: 2 }, documents: [{ type: 'pan', label: 'PAN', status: 'approved', url: 's3://x' }], missing: [{ type: 'aadhaar', label: 'Aadhaar', requestedBy: 'HR', requestedAt: '2026-09-01' }], expiries: [{ expiringSoon: true }] }),
    get_reporting_chain: ok({ mode: 'chain', person: 'Priya Sharma', designation: 'Dev', onChart: true, chain: [{ level: 1, unit: 'Eng', head: 'Ravi' }], reportingManager: 'Ravi' }),
    get_attendance: (args) => ok({ person: 'Priya Sharma', window: args.window, total: 20, statusBreakdown: { present: 20 }, records: [{ date: '2026-09-30', status: 'present', punchIn: '09:00', punchOut: '18:00', hours: 9, ip: '1.2.3.4' }] }),
    list_leave_requests: ok({ total: 1, records: [{ person: 'Priya Sharma', leaveType: 'casual', status: 'approved', from: '2026-09-20', to: '2026-09-20', days: 1, reviewedBy: 'Ravi' }] }),
    get_training_progress: ok({ person: 'Priya Sharma', total: 2, courses: [{ module: 'A', status: 'completed', percentage: 100 }, { module: 'B', status: 'in_progress', percentage: 40 }] }),
    count_tasks: ok({ total: 4, groups: [{ value: 'completed', count: 1 }, { value: 'todo', count: 3 }], overdue: 1, blocked: 0 }),
    list_tasks: ok({ total: 4, records: [task(1), task(2, 'completed', 'Zeus'), task(3), task(4)] }),
    list_projects: ok({ total: 1, records: [{ id: 'p1', name: 'Apollo', status: 'active' }] }),
    list_activity: (args) => ok(args.filters.targetType === 'User'
      ? { total: 1, records: [{ id: 'l2', at: '2026-09-02T00:00:00Z', actor: 'Admin', action: 'user.update', targetType: 'User', target: 'Priya Sharma' }] }
      : { total: 2, records: [{ id: 'l1', at: '2026-09-05T00:00:00Z', actor: 'HR', action: 'employee.update', targetType: 'Employee', target: 'Priya Sharma' }, { id: 'l3', at: '2026-08-01T00:00:00Z', actor: 'HR', action: 'employee.create', targetType: 'Employee', target: 'Priya Sharma' }] }),
    list_meetings: ok({ total: 1, records: [{ title: 'Standup', scheduledAt: '2026-10-01T04:00:00Z', status: 'scheduled', hosts: [] }] }),
    list_call_followups: (args) => ok(args.kind === 'callbackOverdue'
      ? { total: 1, records: [{ applicationId: 'a9', applicant: 'Priya Sharma', job: 'Dev', applicationStatus: 'Applied', callbackAt: '2026-09-29' }] }
      : { total: 60, records: [{ applicationId: 'a1', applicant: 'Priya Sharma', job: 'QA', applicationStatus: 'Applied', callbackAt: '2026-10-02' }, { applicationId: 'a2', applicant: 'Priya Sharmaji', job: 'QA', applicationStatus: 'Applied', callbackAt: '2026-10-02' }] }),
  };
}

function harness(responses, { viewerId = 'viewer000000000000000001' } = {}) {
  const calls = [];
  const runTool = async (name, args, _ctx, opts) => {
    calls.push({ name, args, opts });
    const r = responses[name];
    if (typeof r === 'function') return r(args);
    return r ?? { status: 'unknown' };
  };
  const ctx = { user: { id: viewerId, authContext: { permissions: new Set() } }, deps: { runTool, now: () => NOW } };
  return { ctx, calls, names: () => calls.map((c) => c.name) };
}

const run = (args, responses, opts) => {
  const h = harness(responses, opts);
  return getPerson360.execute(args, h.ctx).then((result) => ({ result, ...h }));
};

// Real tool schemas: every call the 360 makes must pass the child's own Joi input, or it would come back `invalid`.
let toolsByName;
before(async () => {
  const { default: domains } = await import('../../index.js');
  toolsByName = new Map(domains.flatMap((d) => d.tools).map((t) => [t.name, t]));
});
function assertCallsValid(calls) {
  for (const c of calls) {
    const tool = toolsByName.get(c.name);
    assert.ok(tool, `${c.name} is a registered tool`);
    const { error } = tool.input.validate(c.args ?? {}, { abortEarly: false });
    assert.equal(error, undefined, `${c.name} ${JSON.stringify(c.args)}: ${error?.message}`);
  }
}

describe('get_person_360 — definition', () => {
  it('is a read composite in the person domain with a note access and a 15 s ceiling', () => {
    assert.equal(getPerson360.name, 'get_person_360');
    assert.equal(getPerson360.domain, 'person');
    assert.equal(getPerson360.kind, 'read');
    assert.ok(getPerson360.access.note);
    assert.equal(getPerson360.timeoutMs, 15000);
    assert.deepEqual(Object.keys(getPerson360.jsonSchema.properties).sort(), ['focus', 'person', 'sections']);
  });

  it('input rejects unknown sections and focus values', () => {
    assert.ok(getPerson360.input.validate({ sections: ['salary'] }).error);
    assert.ok(getPerson360.input.validate({ focus: 'tomorrow' }).error);
    assert.equal(getPerson360.input.validate({ person: 'Priya', sections: ['offer'] }).error, undefined);
  });

  it('throws without an authenticated user (fail closed)', async () => {
    await assert.rejects(getPerson360.execute({ person: 'x' }, { deps: {} }), /authenticated user/);
  });
});

describe('get_person_360 — resolving the person once', () => {
  it('ambiguous name → { matches } and no section runs', async () => {
    const matches = [{ userId: 'u1', name: 'Priya Sharma', email: 'a@x.com' }, { userId: 'u2', name: 'Priya Sharma', email: 'b@x.com' }];
    const { result, names } = await run({ person: 'Priya Sharma' }, { get_user: ok({ matches }) });
    assert.deepEqual(result, { matches });
    assert.deepEqual(names(), ['get_user']);
  });

  it('no match → notFound and no section runs', async () => {
    const { result, names } = await run({ person: 'Nobody' }, { get_user: ok({ matches: [] }) });
    assert.deepEqual(result, { notFound: true, searchedFor: 'Nobody' });
    assert.deepEqual(names(), ['get_user']);
  });

  it('get_user restricted → resolved false with the users.read note, no data', async () => {
    const { result, names } = await run({ person: 'Priya' }, { get_user: { status: 'restricted' } });
    assert.equal(result.resolved, false);
    assert.equal(result.profile.status, 'restricted');
    assert.match(result.note, /users\.read/);
    assert.deepEqual(names(), ['get_user']);
  });

  it('get_user timeout / unavailable → the profile status, no sections', async () => {
    const t = await run({ person: 'Priya' }, { get_user: { status: 'timeout' } });
    assert.equal(t.result.profile.status, 'timeout');
    const u = await run({ person: 'Priya' }, { get_user: ok({ error: 'unavailable' }) });
    assert.equal(u.result.profile.status, 'error');
    assert.deepEqual(u.names(), ['get_user']);
  });

  it('a 24-hex person is looked up by id; the resolve step has its own 5 s timeout', async () => {
    const { calls } = await run({ person: U1, sections: ['profile'] }, { get_user: uniqueUser(['employee']) });
    assert.deepEqual(calls[0], { name: 'get_user', args: { id: U1 }, opts: { timeoutMs: 5000 } });
  });

  it('omitted person → get_my_profile, self = true', async () => {
    const r = await run({ sections: ['profile'] }, { get_my_profile: uniqueUser(['employee'], { userId: 'viewer000000000000000001' }) });
    assert.equal(r.calls[0].name, 'get_my_profile');
    assert.equal(r.result.person.self, true);
  });
});

describe('get_person_360 — full 360', () => {
  it('both roles: every section runs, in order, each { status, summary, rows ≤ 5 }', async () => {
    const { result, calls } = await run({ person: 'Priya Sharma' }, { get_user: uniqueUser(['employee', 'candidate']), ...goodResponses() });
    assertCallsValid(calls.slice(1));
    assert.deepEqual(Object.keys(result.sections), SECTIONS);
    assert.equal(result.focus, 'all');
    assert.equal(result.today, IST_TODAY);
    assert.deepEqual(result.person, { userId: U1, name: 'Priya Sharma', roles: ['Employee', 'Candidate'], self: false, candidate: true, employee: true });
    for (const [key, s] of Object.entries(result.sections)) {
      if (key === 'externalJobs') continue;
      assert.equal(s.status, 'ok', `${key}: ${JSON.stringify(s)}`);
      assert.ok(s.rows.length <= 5, key);
    }
    // Section calls run in parallel, each with the 8 s section timeout.
    assert.ok(calls.slice(1).every((c) => c.opts.timeoutMs === 8000));
  });

  it('shapes each section from its own tool, with the full total and no extra fields', async () => {
    const { result, calls } = await run({ person: 'Priya Sharma' }, { get_user: uniqueUser(['employee', 'candidate']), ...goodResponses() });
    const s = result.sections;
    // profile: redacted field hidden, unknown fields (salary) never copied
    assert.deepEqual(s.profile.summary.employee, { employeeId: 'E1', designation: 'Dev', position: null, joiningDate: '2026-01-05', employmentStatus: null, reportingManager: null });
    assert.equal(s.applications.summary.total, 7);
    assert.equal(s.applications.rows.length, 5);
    assert.equal(s.calls.summary.answerRate, 50);
    assert.equal(s.calls.summary.applicantsTotal, undefined, 'org-wide applicant metrics are not per person');
    assert.equal(s.calls.rows[0].phone, undefined);
    // exact name only — "Priya Sharmaji" is someone else
    assert.equal(s.interviews.summary.total, 2);
    assert.deepEqual(s.interviews.rows.map((r) => r.jobPosition), ['Dev', 'Ops']);
    assert.equal(s.offer.summary.compensation, undefined);
    assert.equal(s.offer.summary.status, 'Sent');
    assert.equal(s.placement.summary.firstBlockingStep, 'Background check');
    assert.deepEqual(s.documents.summary.missing, ['Aadhaar']);
    assert.equal(s.documents.rows[0].url, undefined);
    assert.equal(s.org.summary.reportingManager, 'Ravi');
    assert.deepEqual(s.attendance.summary.window, { from: '2026-09-02', to: IST_TODAY });
    assert.equal(s.attendance.rows[0].ip, undefined);
    assert.equal(s.training.summary.completed, 1);
    assert.deepEqual(s.work.summary.tasks, { total: 4, open: 3, overdue: 1, blocked: 0 });
    assert.deepEqual(s.work.summary.projectsFromTasks, ['Apollo', 'Zeus']);
    assert.deepEqual(s.work.summary.projectsNamingThem, { total: 1, names: ['Apollo'] });
    // activity: record + login account, newest first
    assert.equal(s.activity.summary.total, 3);
    assert.deepEqual(s.activity.rows.map((r) => r.action), ['employee.update', 'user.update', 'employee.create']);
    assert.equal(s.externalJobs.status, 'notCaptured');
    assert.match(s.externalJobs.note, /not captured in DharwinOne/);

    const args = Object.fromEntries(calls.map((c) => [c.name, c.args]));
    assert.deepEqual(args.get_offer, { candidate: 'priya@x.com' }, 'lookups use the email when known');
    assert.deepEqual(args.list_applications, { filters: { applicantUserId: U1 }, limit: 5 });
    assert.deepEqual(args.get_attendance.window, { from: '2026-09-02', to: IST_TODAY }, '30 IST days, today included');
    assert.deepEqual(args.count_tasks.filters, { assigneeUserId: U1 });
    assert.deepEqual(calls.filter((c) => c.name === 'list_activity').map((c) => c.args.filters),
      [{ targetType: 'Employee', target: 'Priya Sharma' }, { targetType: 'User', target: U1 }]);
  });

  it('pure employee: candidate-only sections are notRecorded and their tools never run', async () => {
    const { result, names } = await run({ person: 'Priya Sharma' }, { get_user: uniqueUser(['employee']), ...goodResponses() });
    for (const key of ['referral', 'offer', 'placement', 'documents']) {
      assert.equal(result.sections[key].status, 'notRecorded', key);
      assert.match(result.sections[key].note, /Candidate-only/);
    }
    for (const tool of ['get_referral', 'get_offer', 'get_placement', 'list_documents']) assert.ok(!names().includes(tool), tool);
    assert.equal(result.sections.org.status, 'ok');
  });

  it('pure candidate: employee-only sections are notRecorded and their tools never run', async () => {
    const { result, names } = await run({ person: 'Priya Sharma' }, { get_user: uniqueUser(['candidate']), ...goodResponses() });
    for (const key of ['org', 'attendance', 'leave', 'work']) assert.equal(result.sections[key].status, 'notRecorded', key);
    for (const tool of ['get_reporting_chain', 'get_attendance', 'list_leave_requests', 'count_tasks', 'list_tasks', 'list_projects']) {
      assert.ok(!names().includes(tool), tool);
    }
    assert.equal(result.sections.offer.status, 'ok');
  });

  it('person with no Employee profile (e.g. an administrator): sections run, missing records are notRecorded', async () => {
    const responses = {
      get_user: uniqueUser(['administrator'], { profiles: { administrator: { fields: {} } } }),
      get_referral: ok({ notFound: true }),
      list_applications: ok({ total: 0, records: [] }),
      list_call_records: ok({ total: 0, records: [] }),
      get_call_metrics: ok({ totalCalls: 0 }),
      list_interviews: ok({ total: 0, records: [] }),
      get_offer: ok({ notFound: true }),
      get_placement: ok({ notFound: true }),
      list_documents: ok({ notFound: true }),
      get_reporting_chain: ok({ mode: 'chain', notFound: true, note: 'No employee profile.' }),
      get_attendance: ok({ notFound: true }),
      list_leave_requests: ok({ notFound: true }),
      get_training_progress: ok({ noStudentProfile: true, note: 'No student profile.' }),
      count_tasks: ok({ total: 0, groups: [] }),
      list_tasks: ok({ total: 0, records: [] }),
      list_projects: ok({ total: 0, records: [] }),
      list_activity: ok({ total: 0, records: [] }),
    };
    const { result, calls } = await run({ person: 'Priya Sharma' }, responses);
    assertCallsValid(calls.slice(1));
    assert.deepEqual(result.sections.profile.summary.otherProfiles, ['administrator']);
    for (const key of SECTIONS.filter((k) => !['profile', 'externalJobs'].includes(k))) {
      assert.equal(result.sections[key].status, 'notRecorded', `${key}: ${JSON.stringify(result.sections[key])}`);
    }
    // No Employee/Candidate role → no person-record activity lookup, only the login account.
    assert.deepEqual(calls.filter((c) => c.name === 'list_activity').map((c) => c.args.filters.targetType), ['User']);
  });

  it('section statuses: restricted / timeout / error / in-band forbidden and error — never filled with data', async () => {
    const responses = {
      ...goodResponses(),
      get_user: uniqueUser(['employee', 'candidate']),
      get_referral: { status: 'restricted' },
      list_applications: { status: 'timeout' },
      get_offer: { status: 'error', error: 'boom' },
      get_placement: { status: 'invalid', error: 'bad args' },
      list_call_followups: undefined,
      list_documents: ok({ error: 'You can only see your own documents.' }),
      list_call_records: ok({ forbidden: true }),
      list_interviews: { status: 'unknown' },
    };
    const { result } = await run({ person: 'Priya Sharma' }, responses);
    const s = result.sections;
    assert.equal(s.referral.status, 'restricted');
    assert.equal(s.applications.status, 'timeout');
    assert.equal(s.offer.status, 'error');
    assert.equal(s.placement.status, 'error');
    assert.equal(s.documents.status, 'restricted');
    assert.equal(s.calls.status, 'restricted');
    assert.equal(s.interviews.status, 'error');
    for (const key of ['referral', 'applications', 'documents', 'calls']) {
      assert.equal(s[key].summary, undefined, key);
      assert.equal(s[key].rows, undefined, key);
    }
  });

  it('activity: a viewer limited to their own log rows loses the target filter → restricted', async () => {
    const { result } = await run({ person: 'Priya Sharma', sections: ['activity'] }, {
      get_user: uniqueUser(['employee']),
      list_activity: ok({ total: 9, records: [{ at: '2026-09-01', action: 'x' }], ignoredFilters: ['target', 'targetType'] }),
    });
    assert.equal(result.sections.activity.status, 'restricted');
    assert.equal(result.sections.activity.rows, undefined);
  });

  it('interviews: a name search capped at 50 rows is flagged scanTruncated', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, candidate: i < 2 ? 'Priya Sharma' : 'Priya Sharmaji' }));
    const { result } = await run({ person: 'Priya Sharma', sections: ['interviews'] }, {
      get_user: uniqueUser(['candidate']),
      list_interviews: ok({ total: 80, records }),
    });
    assert.equal(result.sections.interviews.summary.total, 2);
    assert.equal(result.sections.interviews.summary.scanTruncated, true);
  });

  it('substring lookups never pass off another person’s record as theirs', async () => {
    const { result } = await run({ person: 'Priya Sharma', sections: ['offer', 'placement', 'referral', 'calls'] }, {
      get_user: uniqueUser(['candidate']),
      ...goodResponses(),
      // "priya@x.com" is a substring of "supriya@x.com": a lone hit is still someone else's.
      get_offer: ok({ offerCode: 'OF-9', candidate: 'Supriya Rao', status: 'Sent' }),
      get_placement: ok({ matches: [{ id: 'p9', candidate: 'Supriya Rao', status: 'Pending' }] }),
      get_referral: ok({ total: 1, records: [{ candidate: 'Supriya Rao', referredBy: 'Amit' }] }),
      list_call_records: ok({ total: 2, records: [{ person: 'Priya Sharma Rao', when: '2026-09-01' }] }),
    });
    const s = result.sections;
    assert.equal(s.offer.status, 'notRecorded');
    assert.equal(s.placement.status, 'notRecorded');
    assert.equal(s.referral.status, 'notRecorded');
    assert.equal(s.calls.status, 'notRecorded');
  });

  it('callbacks match the profile name too, and attendance / leave get the exact user id', async () => {
    const user = uniqueUser(['candidate', 'employee'], { profiles: { candidate: { fields: { name: 'Priya R. Sharma' } } } });
    const { result, calls } = await run({ person: 'Priya Sharma', focus: 'pending' }, {
      get_user: user,
      ...goodResponses(),
      list_call_followups: ok({ total: 1, records: [{ applicant: 'Priya R. Sharma', job: 'Dev', callbackAt: '2026-10-01' }] }),
    });
    assert.equal(result.sections.callbacksDue.summary.due + result.sections.callbacksDue.summary.overdue, 2);
    const leave = calls.find((c) => c.name === 'list_leave_requests');
    assert.equal(leave.args.filters.person, U1);
  });

  it('several records inside a section (duplicate names) → ambiguous summary, not a guess', async () => {
    const matches = [{ id: 'o1', candidate: 'Priya Sharma', status: 'Sent' }, { id: 'o2', candidate: 'Priya Sharma', status: 'Accepted' }];
    const { result } = await run({ person: 'Priya Sharma', sections: ['offer'] }, { get_user: uniqueUser(['candidate']), get_offer: ok({ matches }) });
    assert.equal(result.sections.offer.summary.ambiguous, true);
    assert.equal(result.sections.offer.rows.length, 2);
  });

  it('sections narrows the run to just those sections', async () => {
    const { result, names } = await run({ person: 'Priya Sharma', sections: ['offer'] }, { get_user: uniqueUser(['candidate']), ...goodResponses() });
    assert.deepEqual(Object.keys(result.sections), ['offer']);
    assert.deepEqual(names(), ['get_user', 'get_offer']);
  });

  it('a malformed tool result becomes that section\'s error, not a failed 360', async () => {
    const { result } = await run({ person: 'Priya Sharma', sections: ['applications', 'offer'] }, {
      get_user: uniqueUser(['candidate']), ...goodResponses(), list_applications: ok({ total: 2, records: 'oops' }),
    });
    assert.equal(result.sections.applications.status, 'error');
    assert.equal(result.sections.offer.status, 'ok');
  });

  it('self: tools get "me" arguments instead of a name', async () => {
    const { calls } = await run({}, { get_my_profile: uniqueUser(['employee', 'candidate'], { userId: 'viewer000000000000000001' }), ...goodResponses() });
    assertCallsValid(calls.slice(1));
    const args = Object.fromEntries(calls.map((c) => [c.name, c.args]));
    assert.equal(args.get_attendance.person, undefined);
    assert.deepEqual(args.list_leave_requests, { filters: { mine: true }, limit: 5 });
    assert.deepEqual(args.list_documents, {});
    assert.deepEqual(args.count_tasks.filters, { assignedToMe: true });
  });
});

describe('get_person_360 — focus', () => {
  it('today, someone else: attendance / tasks / leave for the IST day; their meetings are restricted', async () => {
    const { result, calls, names } = await run({ person: 'Priya Sharma', focus: 'today' }, { get_user: uniqueUser(['employee']), ...goodResponses() });
    assertCallsValid(calls.slice(1));
    assert.deepEqual(Object.keys(result.sections), ['attendanceToday', 'tasksDueToday', 'leaveToday', 'meetingsToday']);
    assert.equal(result.focus, 'today');
    const args = Object.fromEntries(calls.map((c) => [c.name, c.args]));
    assert.deepEqual(args.get_attendance.window, { from: IST_TODAY, to: IST_TODAY });
    assert.deepEqual(args.list_tasks.filters.dueBetween, { from: IST_TODAY, to: IST_TODAY });
    assert.deepEqual(args.list_leave_requests.filters, { person: U1, dates: { from: IST_TODAY, to: IST_TODAY }, status: 'approved' });
    assert.equal(result.sections.meetingsToday.status, 'restricted');
    assert.ok(!names().includes('list_meetings'));
  });

  it('today, self: includes the viewer\'s own meetings', async () => {
    const { result, calls } = await run({ focus: 'today' }, { get_my_profile: uniqueUser(['employee'], { userId: 'viewer000000000000000001' }), ...goodResponses() });
    assertCallsValid(calls.slice(1));
    assert.equal(result.sections.meetingsToday.status, 'ok');
    assert.deepEqual(calls.find((c) => c.name === 'list_meetings').args.filters, { mine: true, scheduledBetween: { from: IST_TODAY, to: IST_TODAY } });
  });

  it('pending: open tasks, pending leave, missing documents, callbacks, interviews awaiting result, offer pending', async () => {
    const { result, calls } = await run({ person: 'Priya Sharma', focus: 'pending' }, { get_user: uniqueUser(['employee', 'candidate']), ...goodResponses() });
    assertCallsValid(calls.slice(1));
    const s = result.sections;
    assert.deepEqual(Object.keys(s), ['openTasks', 'pendingLeave', 'missingDocuments', 'callbacksDue', 'interviewsAwaitingResult', 'offerPending']);
    assert.equal(s.openTasks.summary.open, 3);
    assert.ok(s.openTasks.rows.every((r) => r.status !== 'completed'));
    assert.equal(calls.find((c) => c.name === 'list_leave_requests').args.filters.status, 'pending');
    assert.equal(s.missingDocuments.summary.missing, 1);
    // callbacks: exact name only, overdue first, truncation flagged
    assert.deepEqual(s.callbacksDue.summary, { due: 1, overdue: 1, scanTruncated: true, note: 'Only the first 50 callbacks of each kind were read.' });
    assert.equal(s.callbacksDue.rows[0].overdue, true);
    assert.equal(calls.find((c) => c.name === 'list_interviews').args.filters.resultMissing, true);
    assert.equal(s.offerPending.status, 'ok');
  });

  it('pending: an accepted offer is not pending; a pure employee skips candidate-only items', async () => {
    const accepted = await run({ person: 'Priya Sharma', focus: 'pending' }, {
      get_user: uniqueUser(['candidate']), ...goodResponses(), get_offer: ok({ offerCode: 'OF-1', candidate: 'Priya Sharma', status: 'Accepted' }),
    });
    assert.equal(accepted.result.sections.offerPending.status, 'notRecorded');
    const emp = await run({ person: 'Priya Sharma', focus: 'pending' }, { get_user: uniqueUser(['employee']), ...goodResponses() });
    assert.equal(emp.result.sections.missingDocuments.status, 'notRecorded');
    assert.equal(emp.result.sections.offerPending.status, 'notRecorded');
    assert.ok(!emp.names().includes('get_offer'));
  });
});

describe('get_person_360 — render', () => {
  it('one table row per section with its status; null when the person was not resolved', async () => {
    const { result } = await run({ person: 'Priya Sharma' }, { get_user: uniqueUser(['employee', 'candidate']), ...goodResponses() });
    const out = getPerson360.render(result);
    assert.equal(out.blocks[0].tableType, 'person-360');
    assert.equal(out.blocks[0].rows.length, SECTIONS.length);
    assert.equal(out.blocks[0].rows.find((r) => r.section === 'applications').total, '7');
    assert.equal(out.facts, undefined, 'per-section totals must not be rewritten as one count');
    assert.equal(getPerson360.render({ matches: [] }), null);
  });
});
