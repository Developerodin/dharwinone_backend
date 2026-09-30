import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import explainStatus from '../explainStatus.tool.js';
import recommend from '../recommend.tool.js';
import matchJobsToEmployee, { scoreJob } from '../matchJobsToEmployee.tool.js';
import adviceDomain from '../index.js';
import { ADVICE_ACCESS, adviceScope, sectionStatus } from '../common.js';
import { joinJobFacts } from '../recommendKinds.js';

const NOW = new Date('2026-09-30T06:30:00Z'); // 12:00 IST, Wednesday
const ALL = ['users.read', 'employees.read', 'jobs.read', 'candidates.read', 'projects.read', 'tasks.read'];
const userWith = (perms = ALL, extra = {}) => ({ id: 'u-viewer', authContext: { permissions: new Set(perms) }, ...extra });

const ok = (result) => ({ status: 'ok', result });
const RESTRICTED = { status: 'restricted' };
const TIMEOUT = { status: 'timeout' };
const ERROR = { status: 'error', error: 'boom' };

/**
 * A fake compose.runTool. `handlers[name]` is an outcome or (args) => outcome; an unlisted tool is 'unknown',
 * like an unregistered one. Every call is recorded so tests can assert what was (never) asked.
 */
function fakeRun(handlers) {
  const calls = [];
  const runTool = async (name, args) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (h === undefined) return { status: 'unknown' };
    return typeof h === 'function' ? h(args) : h;
  };
  return { runTool, calls };
}
const ctxWith = (handlers, { user = userWith(), deps = {} } = {}) => {
  const f = fakeRun(handlers);
  return { ctx: { user, deps: { runTool: f.runTool, now: () => NOW, ...deps } }, calls: f.calls };
};

const employeeUser = (over = {}) => ok({
  kind: 'unique',
  identity: { userId: 'u-priya', name: 'Priya Shah', roles: ['Employee'] },
  roles: [{ name: 'Employee' }],
  profiles: { employee: { fields: { employmentStatus: 'active' }, visibleFields: ['employmentStatus'], redacted: [] } },
  ...over,
});
const candidateUser = () => ok({
  kind: 'unique',
  identity: { userId: 'u-ravi', name: 'Ravi Kumar', roles: ['Candidate'] },
  roles: [{ name: 'Candidate' }],
  profiles: { candidate: { fields: {}, visibleFields: [], redacted: [] } },
});
const leaveList = (records = [], scope = 'all') => ok({ total: records.length, scope, records });
const bucket = (records = [], total = records.length) => ok({ mode: 'list', total, records });
const byRule = (res, prefix) => res.rules.find((r) => r.rule.startsWith(prefix));

describe('advice domain', () => {
  it('exports one-line summary, instructions and three read tools with a composite note access', () => {
    assert.equal(adviceDomain.domain, 'advice');
    assert.ok(adviceDomain.summary.length <= 120 && !adviceDomain.summary.includes('\n'));
    assert.deepEqual(adviceDomain.tools.map((t) => t.name), ['explain_status', 'recommend', 'match_jobs_to_employee']);
    for (const t of adviceDomain.tools) {
      assert.equal(t.kind, 'read');
      assert.deepEqual(t.access, ADVICE_ACCESS);
      assert.ok(t.timeoutMs <= 15000);
    }
  });

  it('fails closed without a user id', async () => {
    assert.throws(() => adviceScope({ user: {} }), /authenticated user/);
    await assert.rejects(explainStatus.execute({ person: 'x', question: 'why_unavailable' }, { user: {} }), /authenticated user/);
  });

  it('sectionStatus maps compose statuses and tool-level refusals', () => {
    assert.equal(sectionStatus(ok({})).status, 'ok');
    assert.equal(sectionStatus(ok({ forbidden: true, error: 'no' })).status, 'restricted');
    assert.equal(sectionStatus(ok({ error: 'Job not found' })).status, 'error');
    assert.equal(sectionStatus(RESTRICTED).status, 'restricted');
    assert.equal(sectionStatus(TIMEOUT).status, 'timeout');
    assert.equal(sectionStatus({ status: 'unknown' }).status, 'error');
    assert.equal(sectionStatus({ status: 'invalid', error: 'bad' }).status, 'error');
  });
});

describe('explain_status', () => {
  it('why_unavailable happy path: every rule met', async () => {
    const { ctx } = ctxWith({
      get_user: employeeUser(),
      who_is_on_leave_today: leaveList([{ name: 'Someone Else', leaveType: 'casual' }]),
      get_allocation: bucket([]),
      get_placement: ok({ notFound: 'placement' }),
    });
    const res = await explainStatus.execute({ person: 'priya', question: 'why_unavailable' }, ctx);
    assert.equal(res.person, 'Priya Shah');
    assert.deepEqual(res.rules.map((r) => r.met), [true, true, true]);
    assert.equal(res.conclusion, 'No availability rule applies to them.');
    assert.equal(res.sections.placement, 'ok');
    for (const r of res.rules) assert.ok(r.source && r.rule);
  });

  it('a placement or allocation miss never stands in for the person', async () => {
    // get_placement matches substrings: "Ravi Kumar" returns Ravi Kumar Singh's placement as its lone hit.
    const { ctx } = ctxWith({
      get_user: candidateUser(),
      who_is_on_leave_today: leaveList([]),
      get_allocation: bucket([]),
      get_placement: ok({ candidate: 'Ravi Kumar Singh', status: 'Pending', steps: [] }),
    });
    const res = await explainStatus.execute({ person: 'Ravi', question: 'cannot_move_to_onboarding' }, ctx);
    assert.equal(byRule(res, 'Placement status may move').met, null);
    // A Candidate is not in the employee allocation lists, so missing from them proves nothing.
    const why = await explainStatus.execute({ person: 'Ravi', question: 'why_unavailable' }, ctx);
    assert.equal(why.rules.find((r) => /project/i.test(r.rule)).met, null);
  });

  it('why_unavailable: on leave and at the project limit are both named', async () => {
    const { ctx } = ctxWith({
      get_user: employeeUser(),
      who_is_on_leave_today: leaveList([{ name: 'Priya Shah', leaveType: 'sick', from: '2026-09-30', to: '2026-10-01' }]),
      get_allocation: (a) => bucket(a.bucket === 'projects_2' ? [{ name: 'Priya Shah', activeProjects: 2 }] : []),
      get_placement: ok({ notFound: 'placement' }),
    });
    const res = await explainStatus.execute({ person: 'Priya Shah', question: 'why_unavailable' }, ctx);
    assert.equal(byRule(res, 'Not on leave').met, false);
    assert.equal(byRule(res, 'Not on leave').evidence.leaveType, 'sick');
    assert.equal(byRule(res, 'Under the active-project limit').met, false);
    assert.match(res.conclusion, /^Unavailable because: .*leave.*project limit/);
  });

  it('restricted / timeout / error sections give met null and are named, never filled', async () => {
    const { ctx } = ctxWith({
      get_user: employeeUser(),
      who_is_on_leave_today: RESTRICTED,
      get_allocation: (a) => (a.bucket === 'projects_2' ? TIMEOUT : bucket([])),
      get_placement: ERROR,
    });
    const res = await explainStatus.execute({ person: 'Priya Shah', question: 'why_unavailable' }, ctx);
    assert.deepEqual(res.sections, { profile: 'ok', leave: 'restricted', atTwo: 'timeout', atThreePlus: 'ok', placement: 'error' });
    assert.equal(byRule(res, 'Not on leave').met, null);
    assert.match(byRule(res, 'Not on leave').evidence, /may not see/);
    assert.equal(byRule(res, 'Under the active-project limit').met, null);
    assert.equal(res.rules.some((r) => r.rule.startsWith('Has joined')), false);
    assert.match(res.conclusion, /could not check/);
  });

  it('a leave view scoped to self or a truncated at-limit list proves nothing', async () => {
    const { ctx } = ctxWith({
      get_user: employeeUser(),
      who_is_on_leave_today: leaveList([], 'self'),
      get_allocation: (a) => bucket([], a.bucket === 'projects_2' ? 80 : 0),
      get_placement: ok({ notFound: 'placement' }),
    });
    const res = await explainStatus.execute({ person: 'Priya Shah', question: 'why_unavailable' }, ctx);
    assert.equal(byRule(res, 'Not on leave').met, null);
    assert.equal(byRule(res, 'Under the active-project limit').met, null);
  });

  it('duplicate names stop with matches; nobody found is notFound', async () => {
    const dup = ctxWith({ get_user: ok({ matches: [{ name: 'Priya A' }, { name: 'Priya B' }] }) });
    const res = await explainStatus.execute({ person: 'Priya', question: 'why_unavailable' }, dup.ctx);
    assert.equal(res.matches.length, 2);
    assert.equal(dup.calls.length, 1);
    const none = ctxWith({ get_user: ok({ matches: [] }) });
    assert.equal((await explainStatus.execute({ person: 'Nobody', question: 'why_unavailable' }, none.ctx)).notFound, 'person');
  });

  it('get_user restricted: continues on the raw name with profile rules unknown', async () => {
    const { ctx } = ctxWith({
      get_user: RESTRICTED,
      get_allocation: ok({ mode: 'can_assign', eligible: true, reason: null, project: 'Apollo', activeProjectsElsewhere: 1, alreadyOnProject: false }),
      who_is_on_leave_today: leaveList([]),
    });
    const res = await explainStatus.execute({ person: 'Priya', question: 'cannot_join_project', project: 'Apollo' }, ctx);
    assert.equal(res.sections.profile, 'restricted');
    assert.equal(res.rules[0].met, true);
    assert.equal(res.context[0].met, null);
    assert.equal(res.conclusion, 'The project-limit rule allows them to join.');
  });

  it('cannot_join_project: needs project; ineligible is the only hard rule; ambiguous project asks', async () => {
    const { ctx } = ctxWith({ get_user: employeeUser() });
    assert.match((await explainStatus.execute({ person: 'P', question: 'cannot_join_project' }, ctx)).error, /needs project/);

    const blocked = ctxWith({
      get_user: employeeUser(),
      get_allocation: ok({ mode: 'can_assign', eligible: false, reason: 'At the 2-active-project limit.', activeProjectsElsewhere: 2, alreadyOnProject: false, maxActiveProjects: 2 }),
      who_is_on_leave_today: leaveList([{ name: 'Priya Shah', leaveType: 'casual' }]),
    });
    const res = await explainStatus.execute({ person: 'Priya', question: 'cannot_join_project', project: 'Apollo' }, blocked.ctx);
    assert.equal(res.rules.length, 1);
    assert.equal(res.rules[0].evidence.activeProjectsElsewhere, 2);
    assert.match(res.conclusion, /^Cannot join because: Under the active-project limit/);
    assert.equal(res.context[1].met, false, 'leave is context, not a reason');

    const amb = ctxWith({ get_user: employeeUser(), get_allocation: ok({ ambiguous: 'project', matches: ['Apollo 1', 'Apollo 2'] }), who_is_on_leave_today: leaveList() });
    const a = await explainStatus.execute({ person: 'Priya', question: 'cannot_join_project', project: 'Apollo' }, amb.ctx);
    assert.equal(a.ambiguous, 'project');
    assert.deepEqual(a.matches, ['Apollo 1', 'Apollo 2']);
  });

  it('cannot_move_to_onboarding: open required pre-boarding step blocks; bypass right is context', async () => {
    const placement = ok({
      candidate: 'Ravi Kumar', status: 'Pending', joiningDate: '2026-10-10', firstBlockingStep: { step: 'Pre-boarding', detail: 'Required checklist step not done: ID proof.' },
      steps: [{ step: 'Pre-boarding', status: 'In Progress', tasks: [{ title: 'ID proof', required: true, done: false }, { title: 'Photo', required: false, done: false }] }],
    });
    const { ctx } = ctxWith({ get_user: candidateUser(), get_placement: placement }, { user: userWith([...ALL, 'preboarding.override']) });
    const res = await explainStatus.execute({ person: 'Ravi', question: 'cannot_move_to_onboarding' }, ctx);
    assert.equal(byRule(res, 'Placement status may move').met, true);
    const gate = byRule(res, 'Pre-boarding gate');
    assert.equal(gate.met, false);
    assert.deepEqual(gate.evidence.openRequiredSteps, ['ID proof']);
    assert.equal(byRule(res, 'You can bypass').met, true);
    assert.match(res.conclusion, /^Blocked from Onboarding: Pre-boarding gate.* You can bypass the pre-boarding gate\.$/);

    const none = ctxWith({ get_user: candidateUser(), get_placement: ok({ notFound: 'placement' }) });
    const r2 = await explainStatus.execute({ person: 'Ravi', question: 'cannot_move_to_onboarding' }, none.ctx);
    assert.equal(byRule(r2, 'Pre-boarding gate').met, null);
    assert.equal(byRule(r2, 'You can bypass').met, false);
  });

  it('not_in_employee_list: a Candidate whose joining day has not arrived; hideFromDirectory is not applied', async () => {
    const { ctx, calls } = ctxWith({
      get_user: candidateUser(),
      get_placement: ok({ candidate: 'Ravi Kumar', status: 'Onboarding', joiningDate: '2026-10-15', holdsEmployeeRole: false, steps: [] }),
    });
    const res = await explainStatus.execute({ person: 'Ravi', question: 'not_in_employee_list' }, ctx);
    assert.equal(byRule(res, 'Their login holds the Employee role').met, false);
    assert.equal(byRule(res, 'Their account is active').met, null);
    const promo = byRule(res, 'Candidate becomes an Employee');
    assert.equal(promo.met, false);
    assert.equal(promo.evidence.joiningDayArrived, false);
    assert.match(res.notApplied[0], /hideFromDirectory/);
    assert.ok(calls.some((c) => c.name === 'get_placement'));
  });

  it('not_in_employee_list: out of the viewer scope, and an Employee skips the placement call', async () => {
    const { ctx, calls } = ctxWith({
      get_user: employeeUser({ profiles: { student: { fields: {} } }, profileNote: 'employee/candidate profile not visible to you' }),
    });
    const res = await explainStatus.execute({ person: 'Priya', question: 'not_in_employee_list' }, ctx);
    assert.equal(byRule(res, 'Has a profile record').met, null);
    assert.equal(byRule(res, 'Inside your Employees-page scope').met, false);
    assert.equal(calls.some((c) => c.name === 'get_placement'), false);
    assert.match(res.conclusion, /^Not on the Employees page because: Inside your Employees-page scope/);
  });

  it('not_in_org_tree: not on the chart and resigned', async () => {
    const { ctx } = ctxWith({
      get_user: employeeUser({ profiles: { employee: { fields: { employmentStatus: 'resigned' }, redacted: [] } } }),
      get_reporting_chain: ok({ mode: 'chain', notFound: 'person', note: 'No active employee by that name on the org chart.' }),
    });
    const res = await explainStatus.execute({ person: 'Priya', question: 'not_in_org_tree' }, ctx);
    assert.equal(byRule(res, 'On the Org Chart').met, false);
    assert.equal(byRule(res, 'Not resigned').met, false);
    assert.equal(byRule(res, 'Placed in an org-chart department').met, null);
    assert.match(res.conclusion, /^Not on the org chart because/);
  });

  it('cannot_see_record: permission vs row scope per module', async () => {
    const { ctx } = ctxWith({
      get_user: RESTRICTED,
      get_placement: ok({ error: 'You do not have access to this placement.' }),
      get_training_progress: ok({ error: 'Other people\'s training needs students.read.' }),
      list_tasks: ok({ records: [], error: 'You can only see your own tasks — other people\'s tasks need tasks.read.' }),
      get_reporting_chain: RESTRICTED,
    });
    const res = await explainStatus.execute({ person: 'Priya', question: 'cannot_see_record' }, ctx);
    assert.match(byRule(res, 'You can open their profile').evidence, /users\.read/);
    assert.equal(byRule(res, 'Their placement is inside').met, false);
    assert.equal(byRule(res, 'Their training is inside').met, false);
    assert.equal(byRule(res, 'Their tasks is inside').met, false);
    assert.match(byRule(res, 'You can open their org-chart').evidence, /chart\.read/);
    assert.match(res.conclusion, /^You cannot see:/);
  });

  it('render: table of rules; null without rules', () => {
    const r = explainStatus.render({ person: 'P', rules: [{ rule: 'A', met: true }, { rule: 'B', met: null }] });
    assert.deepEqual(r.blocks[0].rows.map((x) => x.met), ['yes', 'unknown']);
    assert.equal(explainStatus.render({ matches: [] }), null);
  });
});

describe('recommend', () => {
  it('kinds that need an argument say so', async () => {
    const { ctx } = ctxWith({});
    for (const [kind, need] of [['allocate_to_project', 'project'], ['bench_for_job', 'job'], ['team_task_priorities', 'team']]) {
      assert.equal((await recommend.execute({ kind, limit: 20 }, ctx)).error, `${kind} needs ${need}.`);
    }
  });

  it('follow_ups_today: digest items by severity then count; restricted / unknown digest gives no items', async () => {
    const { ctx, calls } = ctxWith({
      get_attention_digest: ok({
        items: [
          { label: 'Pending leave', severity: 'medium', status: 'ok', count: 4, rows: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }], source: 'list_leave_requests' },
          { label: 'Callbacks overdue', severity: 'high', status: 'ok', count: 1, rows: [] },
          { label: 'Overdue tasks', severity: 'medium', status: 'restricted' },
          { label: 'Never called', severity: 'medium', status: 'ok', count: 0 },
        ],
        restricted: ['Overdue tasks'], failed: [], notScopedToYou: ['Panel clashes'],
      }),
    });
    const res = await recommend.execute({ kind: 'follow_ups_today', limit: 20 }, ctx);
    assert.deepEqual(calls[0], { name: 'get_attention_digest', args: { scope: 'mine' } });
    assert.deepEqual(res.items.map((i) => i.subject), ['Callbacks overdue', 'Pending leave']);
    assert.equal(res.items[1].evidence.examples.length, 3);
    assert.deepEqual(res.restrictedItems, ['Overdue tasks']);
    assert.ok(res.rules.length);

    const r = await recommend.execute({ kind: 'follow_ups_today', limit: 20 }, ctxWith({ get_attention_digest: RESTRICTED }).ctx);
    assert.deepEqual([r.items, r.sections.digest], [[], 'restricted']);
    const u = await recommend.execute({ kind: 'follow_ups_today', limit: 20 }, ctxWith({}).ctx);
    assert.equal(u.sections.digest, 'error');
  });

  it('next_candidate_to_contact: tiers, one row per name, interviewed people drop out of tier 3', async () => {
    const { ctx, calls } = ctxWith({
      list_call_followups: (a) => ok({
        kind: a.kind,
        total: 1,
        records: {
          callbackOverdue: [{ applicant: 'Asha', job: 'Dev', callbackAt: '2026-09-28T05:00:00Z' }],
          callbackRequested: [{ applicant: 'Bala', job: 'QA', callbackAt: '2026-10-02T05:00:00Z' }],
          notYetCalled: [{ applicant: 'Asha', appliedAt: '2026-09-10T05:00:00Z' }, { applicant: 'Chitra', appliedAt: '2026-09-20T05:00:00Z' }],
        }[a.kind],
      }),
      list_call_records: ok({ total: 2, records: [{ person: 'Dev Rao', outcome: 'fully_confirmed', when: '2026-09-29' }, { person: 'Esha', outcome: 'partially_confirmed' }] }),
      list_interviews: ok({ total: 1, records: [{ candidate: 'Esha' }] }),
    });
    const res = await recommend.execute({ kind: 'next_candidate_to_contact', limit: 20 }, ctx);
    assert.deepEqual(res.items.map((i) => i.subject), ['Asha', 'Bala', 'Dev Rao', 'Chitra']);
    assert.equal(res.items[0].score, 102);
    assert.ok(res.items[0].reasons.some((r) => r.includes('never called')), 'lower tier kept as a reason');
    assert.equal(res.total, 4);
    const stale = calls.find((c) => c.args.kind === 'notYetCalled');
    assert.equal(stale.args.appliedBetween.to, '2026-09-25');
  });

  it('next_candidate_to_contact: tier 3 skipped when the AI outcome is hidden or interviews time out', async () => {
    const base = { list_call_followups: ok({ total: 0, records: [] }) };
    const hidden = await recommend.execute({ kind: 'next_candidate_to_contact', limit: 20 }, ctxWith({
      ...base, list_call_records: ok({ total: 1, aiFieldsHidden: true, records: [{ person: 'X', outcome: null }] }), list_interviews: ok({ total: 0, records: [] }),
    }).ctx);
    assert.match(hidden.notes.join(' '), /call-ai\.read/);
    const late = await recommend.execute({ kind: 'next_candidate_to_contact', limit: 20 }, ctxWith({
      ...base, list_call_records: ok({ total: 1, records: [{ person: 'X', outcome: 'fully_confirmed' }] }), list_interviews: TIMEOUT,
    }).ctx);
    assert.equal(late.items.length, 0);
    assert.equal(late.sections.interviews, 'timeout');
    assert.match(late.notes.join(' '), /Tier 3 skipped/);
  });

  it('interview_order: booked excluded, deadline and openings scored, shared job titles not used', async () => {
    const { ctx } = ctxWith({
      list_applications: (a) => ok({
        total: 2,
        records: a.filters.status === 'Screening'
          ? [{ applicant: 'Old', job: 'Dev', status: 'Screening', appliedAt: '2026-09-01T05:00:00Z' }, { applicant: 'Booked', job: 'Dev', status: 'Screening', appliedAt: '2026-09-01T05:00:00Z' }]
          : [{ applicant: 'Fresh', job: 'QA', status: 'Shortlisted', appliedAt: '2026-09-28T05:00:00Z' }, { applicant: 'Twin', job: 'Ops', status: 'Shortlisted', appliedAt: '2026-09-28T05:00:00Z' }],
      }),
      list_interviews: ok({ total: 1, records: [{ candidate: 'Booked' }] }),
      list_jobs: ok({ total: 4, jobs: [
        { jobId: 'j1', title: 'Dev', applicationDeadline: '2026-10-03T00:00:00Z' },
        { jobId: 'j2', title: 'QA', applicationDeadline: null },
        { jobId: 'j3', title: 'Ops' }, { jobId: 'j4', title: 'ops' },
      ] }),
      get_job_stats: ok({ jobs: [{ jobId: 'j1', vacanciesLeft: 2 }, { jobId: 'j2', vacanciesLeft: 0 }] }),
    });
    const res = await recommend.execute({ kind: 'interview_order', limit: 20 }, ctx);
    assert.deepEqual(res.items.map((i) => i.subject), ['Old', 'Twin', 'Fresh']);
    assert.equal(res.items[0].score, 29 + 20 + 10);
    assert.equal(res.items[2].score, 2 - 50 + 5);
    assert.ok(res.items[1].reasons.some((r) => r.includes('several jobs share this title')));
  });

  it('interview_order: an interview linked to the application counts as booked whatever its free-text name', async () => {
    const { ctx } = ctxWith({
      list_applications: (a) => ok({
        total: 1,
        records: a.filters.status === 'Screening' ? [{ id: 'app1', applicant: 'Meera Iyer', job: 'Dev', status: 'Screening', appliedAt: '2026-09-01T05:00:00Z' }] : [],
      }),
      list_interviews: ok({ total: 1, records: [{ candidate: 'Candidate 1', applicationId: 'app1' }] }),
      list_jobs: ok({ total: 0, jobs: [] }),
      get_job_stats: ok({ jobs: [] }),
    });
    const res = await recommend.execute({ kind: 'interview_order', limit: 20 }, ctx);
    assert.deepEqual(res.items, []);
    assert.match(res.notes.join(' '), /another recruiter/, 'interviews.read sees only their own interviews');
  });

  it('joinJobFacts: duplicate titles map to null', () => {
    const m = joinJobFacts([{ jobId: 'a', title: 'X' }, { jobId: 'b', title: 'x ' }, { jobId: 'c', title: 'Y' }], [{ jobId: 'c', vacanciesLeft: 1 }]);
    assert.equal(m.get('x'), null);
    assert.equal(m.get('y').vacanciesLeft, 1);
  });

  it('allocate_to_project: capacity, can_assign, training; never touches the assignment-run writer', async () => {
    const { ctx, calls } = ctxWith({
      list_projects: ok({ total: 1, records: [{ name: 'Apollo' }] }),
      get_allocation: (a) => {
        if (a.mode === 'can_assign') return ok({ eligible: a.person !== 'Busy', reason: a.person === 'Busy' ? 'At the limit.' : null, alreadyOnProject: false });
        return bucket(a.bucket === 'projects_0'
          ? [{ name: 'Anu', activeProjects: 0, openTasks: 2 }, { name: 'Sam', activeProjects: 0, openTasks: 0 }, { name: 'Sam', activeProjects: 0, openTasks: 1 }]
          : [{ name: 'Busy', activeProjects: 1, openTasks: 0 }]);
      },
      get_training_progress: (a) => ok(a.person === 'Anu'
        ? { total: 1, courses: [{ module: 'Java', status: 'completed' }] }
        : { noStudentProfile: true }),
    });
    const res = await recommend.execute({ kind: 'allocate_to_project', project: 'apollo', limit: 20 }, ctx);
    assert.equal(res.project, 'Apollo');
    assert.deepEqual(res.excluded, [{ subject: 'Busy', reason: 'At the limit.' }]);
    assert.equal(res.items[0].subject, 'Anu');
    assert.equal(res.items[0].score, 40 + 18 + 20);
    assert.ok(res.items.filter((i) => i.subject === 'Sam').every((i) => i.reasons.some((r) => r.includes('shares a name'))));
    assert.equal(calls.some((c) => c.name === 'get_allocation' && c.args.person === 'Sam'), false);
    assert.equal(calls.some((c) => /assignment/i.test(c.name)), false);
    assert.equal(res.viewerCanAssign, false, 'assigning is projects.manage; the viewer has projects.read');
    assert.match(res.notes.join(' '), /projects\.manage/);

    const amb = await recommend.execute({ kind: 'allocate_to_project', project: 'Ap', limit: 20 }, ctxWith({
      list_projects: ok({ records: [{ name: 'Apollo' }, { name: 'Apex' }] }), get_allocation: bucket([]),
    }).ctx);
    assert.deepEqual([amb.ambiguous, amb.matches], ['project', ['Apollo', 'Apex']]);
  });

  it('training_before_assignment: incomplete enrolments, no training profile, restricted training', async () => {
    const { ctx } = ctxWith({
      get_allocation: (a) => bucket(a.bucket === 'projects_0' ? [{ name: 'A', activeProjects: 0 }, { name: 'B', activeProjects: 0 }] : [{ name: 'C', activeProjects: 1 }]),
      get_training_progress: (a) => ({
        A: ok({ total: 2, courses: [{ module: 'React', status: 'in-progress', percentage: 40 }, { module: 'Git', status: 'completed' }] }),
        B: ok({ noStudentProfile: true }),
        C: RESTRICTED,
      }[a.person]),
    });
    const res = await recommend.execute({ kind: 'training_before_assignment', limit: 20 }, ctx);
    assert.deepEqual(res.items.map((i) => [i.subject, i.score]), [['A', 25]]);
    assert.deepEqual(res.noTrainingProfile, ['B']);
    assert.deepEqual(res.trainingNotVisible, [{ name: 'C', status: 'restricted' }]);
    assert.equal(res.peopleUnderLimit, 3);
  });

  it('bench_for_job: match ∩ unallocated, falls back to no-project, reports match errors', async () => {
    const match = ok({ job: 'Java Dev', candidates: [{ name: 'Anu', matchPct: 80, skills: ['java'] }, { name: 'Ben', matchPct: 90 }, { name: 'Cy', matchPct: 70 }] });
    const { ctx, calls } = ctxWith({
      match_candidates_to_job: match,
      get_allocation: (a) => (a.bucket === 'unallocated' ? bucket([{ name: 'Anu' }, { name: 'Cy' }]) : bucket([])),
    });
    const res = await recommend.execute({ kind: 'bench_for_job', job: 'Java Dev', limit: 20 }, ctx);
    assert.deepEqual(res.items.map((i) => i.subject), ['Anu', 'Cy']);
    assert.equal(res.basis, 'unallocated');
    assert.deepEqual(calls.find((c) => c.name === 'match_candidates_to_job').args, { jobTitle: 'Java Dev', pool: 'employees', limit: 25 });

    const fb = await recommend.execute({ kind: 'bench_for_job', job: '0123456789abcdef01234567', limit: 20 }, ctxWith({
      match_candidates_to_job: match,
      get_allocation: (a) => (a.bucket === 'unallocated' ? ok({ mode: 'list', total: null, records: [] }) : bucket([{ name: 'Ben' }])),
    }).ctx);
    assert.equal(fb.basis, 'projects_0');
    assert.deepEqual(fb.items.map((i) => i.subject), ['Ben']);

    const err = await recommend.execute({ kind: 'bench_for_job', job: 'Nope', limit: 20 }, ctxWith({
      match_candidates_to_job: ok({ error: 'Job not found (or not visible to you).' }), get_allocation: bucket([]),
    }).ctx);
    assert.equal(err.sections.match, 'error');
    assert.match(err.matchError, /Job not found/);
  });

  it('team_task_priorities: overdue first, then priority and due date; completed and undated dropped', async () => {
    const tasks = [
      { id: 't1', title: 'Late', status: 'todo', priority: 'low', dueDate: '2026-09-25T00:00:00Z' },
      { id: 't2', title: 'Urgent soon', status: 'todo', priority: 'urgent', dueDate: '2026-10-02T00:00:00Z' },
      { id: 't3', title: 'Done', status: 'completed', priority: 'urgent', dueDate: '2026-09-20T00:00:00Z' },
      { id: 't4', title: 'Undated', status: 'todo', priority: 'high', dueDate: null },
    ];
    const { ctx, calls } = ctxWith({ list_tasks: (a) => ok({ total: 4, scope: 'mine', records: a.filters.overdue ? [tasks[0]] : tasks }) });
    const res = await recommend.execute({ kind: 'team_task_priorities', team: 'Alpha', limit: 20 }, ctx);
    const upcoming = calls.find((c) => c.name === 'list_tasks' && !c.args.filters.overdue);
    assert.deepEqual(upcoming.args.filters.dueBetween, { from: '2026-09-30' }, 'from today, not the oldest tasks');
    assert.deepEqual(res.items.map((i) => i.subject), ['Late', 'Urgent soon']);
    assert.equal(res.items[0].score, 105);
    assert.equal(res.items[1].score, 30 + 12);
    assert.match(res.notes.join(' '), /tasks\.read/);

    const nf = await recommend.execute({ kind: 'team_task_priorities', team: 'Nope', limit: 20 }, ctxWith({
      list_tasks: ok({ records: [], notFound: 'team', searchedFor: 'Nope', total: 0 }),
    }).ctx);
    assert.equal(nf.notFound, 'team');
  });

  it('recruiter_capacity: restricted without jobs.read; median and flag from the scoped job + application counts', async () => {
    const denied = await recommend.execute({ kind: 'recruiter_capacity', limit: 20 }, ctxWith({}, { user: userWith(['employees.read']) }).ctx);
    assert.deepEqual([denied.items, denied.sections.jobs], [[], 'restricted']);

    let seenFilter = null;
    const jobs = [
      { _id: 'j1', assignedRecruiter: { _id: 'r1', name: 'Rita' } },
      { _id: 'j2', assignedRecruiter: null, createdBy: { _id: 'r2', name: 'Om' } },
      { _id: 'j3', assignedRecruiter: { _id: 'r3', name: 'Lee' } },
    ];
    const Job = { find: (f) => { seenFilter = f; return { select: () => ({ populate: () => ({ limit: () => ({ lean: async () => jobs }) }) }) }; } };
    const { ctx } = ctxWith({}, { deps: {
      Job,
      resolveJobVisibilityFilter: async () => ({ org: 'mine' }),
      aggregateApplicationsByJob: async () => [
        { jobId: 'j1', byStage: { Applied: 20, Interview: 5, Hired: 3 }, interviewed: 6 },
        { jobId: 'j2', byStage: { Applied: 5 }, interviewed: 0 },
        { jobId: 'j3', byStage: { Screening: 10, Rejected: 9 }, interviewed: 1 },
      ],
    } });
    const res = await recommend.execute({ kind: 'recruiter_capacity', limit: 20 }, ctx);
    assert.match(JSON.stringify(seenFilter), /Active/);
    assert.match(JSON.stringify(seenFilter), /mine/);
    assert.equal(res.medianOpen, 10);
    assert.deepEqual(res.items.map((i) => [i.subject, i.score]), [['Rita', 250], ['Lee', 100], ['Om', 50]]);
    assert.equal(res.items[0].evidence.openApplications, 25);
    assert.match(res.suggestion, /Rita/);
    assert.match(res.rules.join(' '), /never a judgement/);
  });

  it('limit keeps the full total', async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({ applicant: `P${String(i).padStart(2, '0')}`, appliedAt: '2026-09-01T05:00:00Z' }));
    const { ctx } = ctxWith({
      list_call_followups: (a) => ok({ total: a.kind === 'notYetCalled' ? 30 : 0, records: a.kind === 'notYetCalled' ? records : [] }),
      list_call_records: ok({ total: 0, records: [] }), list_interviews: ok({ total: 0, records: [] }),
    });
    const res = await recommend.execute({ kind: 'next_candidate_to_contact', limit: 5 }, ctx);
    assert.equal(res.total, 30);
    assert.equal(res.items.length, 5);
  });
});

describe('match_jobs_to_employee', () => {
  const employeeDeps = (rows, capture = {}) => ({
    applyEmployeeListScope: async (f) => { capture.apiFilter = f; return f; },
    buildEmployeeListMongoFilter: async (f) => ({ mongoFilter: { scoped: true, search: f.search } }),
    Employee: { find: (f) => { capture.mongo = f; return { select: () => ({ limit: () => ({ lean: async () => rows }) }) }; } },
  });
  const priya = { fullName: 'Priya Shah', designation: 'Java Developer', skills: [{ name: 'Java' }, { name: 'Spring' }, { name: 'SQL' }] };

  it('restricted without an employees read permission', async () => {
    const { ctx, calls } = ctxWith({}, { user: userWith(['jobs.read']) });
    const res = await matchJobsToEmployee.execute({ person: 'Priya', limit: 20 }, ctx);
    assert.equal(res.sections.profile, 'restricted');
    assert.equal(calls.length, 0);
  });

  it('ranks visible jobs by skill-tag overlap with the gap per job', async () => {
    const capture = {};
    const { ctx, calls } = ctxWith({
      list_jobs: ok({ total: 60, jobs: [
        { jobId: 'j1', title: 'Senior Java Developer', skillTags: ['Java', 'Spring', 'Kafka'] },
        { jobId: 'j2', title: 'Data Analyst', skillTags: ['SQL', 'Python'] },
        { jobId: 'j3', title: 'Designer', skillTags: ['Figma'] },
      ] }),
    }, { deps: employeeDeps([priya], capture) });
    const res = await matchJobsToEmployee.execute({ person: 'Priya Shah', limit: 20 }, ctx);
    assert.equal(capture.apiFilter.ownerUserRole, 'employee');
    assert.equal(capture.apiFilter.search, 'Priya Shah');
    assert.deepEqual(calls[0].args.filters.search, ['Java', 'Spring', 'SQL', 'Java Developer']);
    assert.equal(calls[0].args.filters.jobOrigin, 'internal', 'external listings are not openings');
    assert.deepEqual(res.jobs.map((j) => j.jobId), ['j1', 'j2']);
    assert.equal(res.jobs[0].score, Math.round((2 / 3) * 80 + 20));
    assert.deepEqual(res.jobs[0].missingSkills, ['kafka']);
    assert.equal(res.total, 2);
    assert.match(res.searchTruncated, /50|3 of 60/);
  });

  it('not found, ambiguous, no skills, and a restricted jobs section', async () => {
    const nf = await matchJobsToEmployee.execute({ person: 'Nobody', limit: 20 }, ctxWith({}, { deps: employeeDeps([]) }).ctx);
    assert.equal(nf.noEmployeeProfile, true);
    const amb = await matchJobsToEmployee.execute({ person: 'Priya', limit: 20 }, ctxWith({}, { deps: employeeDeps([priya, { ...priya, fullName: 'Priya Rao' }]) }).ctx);
    assert.deepEqual(amb.matches, ['Priya Shah', 'Priya Rao']);
    const bare = ctxWith({}, { deps: employeeDeps([{ fullName: 'Bare', skills: [] }]) });
    const b = await matchJobsToEmployee.execute({ person: 'Bare', limit: 20 }, bare.ctx);
    assert.match(b.note, /not captured/);
    assert.equal(bare.calls.length, 0);
    const r = await matchJobsToEmployee.execute({ person: 'Priya Shah', limit: 20 }, ctxWith({ list_jobs: RESTRICTED }, { deps: employeeDeps([priya]) }).ctx);
    assert.deepEqual([r.jobs, r.sections.jobs], [[], 'restricted']);
  });

  it('scoreJob: no skill tags scores on title only', () => {
    assert.deepEqual(scoreJob({ title: 'Java Developer', skillTags: [] }, ['java'], 'Java Developer'),
      { score: 20, matchedSkills: [], missingSkills: [], titleMatch: true, noSkillTags: true });
    assert.equal(scoreJob({ title: 'X', skillTags: ['a'] }, [], null).score, 0);
  });
});
