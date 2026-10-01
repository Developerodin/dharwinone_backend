import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import runCrossCheck from '../runCrossCheck.tool.js';
import crosscheckDomain from '../index.js';
import { guardSet, businessDaysBack, nextWeek, SET_CAP } from '../common.js';
import { employeesToUsers, emailsToUsers, namesForUsers } from '../identity.js';

const NOW = new Date('2026-09-30T06:00:00.000Z'); // Wednesday, 11:30 IST
const id = (n) => `64b7f0c2a1b2c3d4e5f6${String(n).padStart(4, '0')}`;
const U = (n) => id(1000 + n); // user ids
const E = (n) => id(2000 + n); // employee ids
const S = (n) => id(3000 + n); // student ids
const A = (n) => id(4000 + n); // application ids

const userWith = (perms) => ({ id: id(1), name: 'Viewer', email: 'viewer@x.com', authContext: { permissions: new Set(perms) } });
const ALL = [
  'candidates.read', 'offers.read', 'interviews.read', 'evaluation.read', 'projects.read', 'tasks.read',
  'students.manage', 'students.read', 'chart.read', 'pre-boarding.read', 'jobs.read', 'employees.read',
];

/** Chainable Mongoose-query fake: handler(filter, method, field) → rows. Every call is logged. */
function model(name, handler, log) {
  const query = (method, filter) => {
    const q = {
      select: () => q, sort: () => q, populate: () => q, maxTimeMS: () => q,
      limit: (n) => { q.n = n; return q; },
      lean: async () => {
        log.push({ model: name, method, filter });
        const rows = (await handler(filter, method)) || [];
        return q.n ? rows.slice(0, q.n) : rows;
      },
    };
    return q;
  };
  return {
    find: (f) => query('find', f),
    distinct: async (field, f) => { log.push({ model: name, method: 'distinct', filter: f }); return (await handler(f, 'distinct', field)) || []; },
  };
}

const inIds = (f, key = '_id') => (f?.[key]?.$in || []).map(String);
const clauseOf = (f) => f?.$and?.[f.$and.length - 1] ?? f;

function ctxFor(perms, over = {}) {
  const log = [];
  const handlers = over.models || {};
  const m = (name) => model(name, handlers[name] || (() => []), log);
  const deps = {
    now: () => NOW,
    isAdmin: async () => false,
    Employee: m('Employee'), User: m('User'), Student: m('Student'), JobApplication: m('JobApplication'),
    Meeting: m('Meeting'), InternalMeeting: m('InternalMeeting'), Offer: m('Offer'), Placement: m('Placement'),
    Task: m('Task'), LeaveRequest: m('LeaveRequest'), Job: m('Job'),
    buildPlacementVisibilityClause: async () => ({ unrestricted: true }),
    buildOfferVisibilityClause: async () => ({ unrestricted: true }),
    meetingScope: async () => ({ filter: {} }),
    internalMeetingScope: async () => ({ filter: {} }),
    buildLeaveRequestScopeFilter: async () => ({ scope: 'all', filter: {} }),
    buildAccessibleTaskFilter: async (u, extra) => extra,
    buildApplicantQuery: async () => ({ query: {} }),
    authorizeEmployeeQuery: () => ({ allowed: true }),
    applyEmployeeListScope: async (f) => f,
    buildEmployeeListMongoFilter: async () => ({ mongoFilter: { population: true } }),
    countActiveProjects: async () => new Map(),
    getEvaluationData: async () => ({ evaluations: [] }),
    canSeeAllReferralLeads: async () => true,
    buildTree: async () => ({ roots: [], unassigned: [] }),
    runTool: async () => ({ status: 'unknown' }),
    ...over.deps,
  };
  return { ctx: { user: over.user || userWith(perms), deps }, log };
}

const run = (query, args, c, limit) => runCrossCheck.execute({ query, args, ...(limit ? { limit } : {}) }, c.ctx);

describe('crosscheck domain', () => {
  it('registers two read tools with a one-line summary and composite timeouts', () => {
    assert.equal(crosscheckDomain.domain, 'crosscheck');
    assert.ok(crosscheckDomain.summary.length <= 120);
    assert.deepEqual(crosscheckDomain.tools.map((t) => t.name), ['run_cross_check', 'get_recruitment_funnel']);
    for (const t of crosscheckDomain.tools) {
      assert.equal(t.kind, 'read');
      assert.ok(t.timeoutMs <= 15000);
      assert.ok(t.access.note);
    }
  });

  it('rejects an unknown query name', () => {
    const { error } = runCrossCheck.input.validate({ query: 'everyone_everywhere' });
    assert.ok(error);
  });
});

describe('IST day helpers', () => {
  it('next week is the next Monday–Sunday', () => {
    assert.deepEqual(nextWeek('2026-09-30'), { from: '2026-10-05', to: '2026-10-11' });
    assert.deepEqual(nextWeek('2026-10-05'), { from: '2026-10-12', to: '2026-10-18' });
  });

  it('business days skip weekends and holidays', () => {
    assert.equal(businessDaysBack('2026-09-30', 5), '2026-09-23');
    assert.equal(businessDaysBack('2026-09-30', 5, new Set(['2026-09-25'])), '2026-09-22');
  });

  it('guardSet turns a hung builder into a timeout section and a throw into an error section', async () => {
    assert.deepEqual(await guardSet('Slow', () => new Promise(() => {}), 10), { status: 'timeout', label: 'Slow' });
    const err = await guardSet('Bad', async () => { throw new Error('boom'); }, 1000);
    assert.equal(err.status, 'error');
    assert.equal(err.reason, 'boom');
  });
});

describe('identity mapping', () => {
  it('maps Employee → owner, and never maps a shared owner whose login email differs (recruiter-owned profile)', async () => {
    const log = [];
    const deps = {
      Employee: model('Employee', (f) => {
        if (f._id) {
          return [
            { _id: E(1), owner: U(1), email: 'asha@x.com' },
            { _id: E(2), owner: U(9), email: 'kiran@x.com' },
            { _id: E(3), owner: U(9), email: 'rec@x.com' },
            { _id: E(4) },
          ];
        }
        return [{ owner: U(1) }, { owner: U(9) }, { owner: U(9) }];
      }, log),
      User: model('User', () => [{ _id: U(9), email: 'rec@x.com' }], log),
    };
    const { map, unmapped } = await employeesToUsers([E(1), E(2), E(3), E(4), 'not-an-id'], deps);
    assert.equal(map.get(E(1)), U(1));
    assert.equal(map.get(E(3)), U(9));
    assert.ok(!map.has(E(2)));
    assert.deepEqual(unmapped.sort(), [E(2), E(4), 'not-an-id'].sort());
  });

  it('email fallback and row names skip candidate profiles a recruiter merely owns', async () => {
    const log = [];
    const profiles = [
      { _id: E(2), owner: U(9), email: 'kiran@x.com', fullName: 'Kiran', employeeId: 'DBS2' },
      { _id: E(3), owner: U(9), email: 'rec@x.com', fullName: 'Recruiter', employeeId: 'DBS3' },
    ];
    const deps = {
      Employee: model('Employee', () => profiles, log),
      User: model('User', (f) => (f.email ? [] : [{ _id: U(9), name: 'Rec Login', email: 'rec@x.com' }]), log),
    };
    const { map, unmapped } = await emailsToUsers(['kiran@x.com', 'rec@x.com'], deps);
    assert.equal(map.get('rec@x.com'), U(9));
    assert.deepEqual(unmapped, ['kiran@x.com']);
    const names = await namesForUsers([U(9)], deps);
    assert.deepEqual(names.get(U(9)), { name: 'Recruiter', employeeId: 'DBS3', employeeProfile: true });
  });
});

describe('run_cross_check — happy path', () => {
  it('joining next week minus pre-boarding completed, with evidence from each side', async () => {
    const c = ctxFor(ALL, {
      models: {
        Placement: (f) => {
          const cl = clauseOf(f);
          const rows = [
            { candidate: E(1), status: 'Pending', preBoardingStatus: 'In Progress', joiningDate: new Date('2026-10-06T00:00:00Z') },
            { candidate: E(2), status: 'Pending', preBoardingStatus: 'Completed', joiningDate: new Date('2026-10-07T00:00:00Z') },
          ];
          assert.ok(cl.joiningDate.$gte instanceof Date);
          return cl.preBoardingStatus === 'Completed' ? rows.filter((r) => r.preBoardingStatus === 'Completed') : rows;
        },
        Employee: (f) => inIds(f).map((x) => ({ _id: x, fullName: x === E(1) ? 'Asha Rao' : 'Kiran', employeeId: x === E(1) ? 'DBS1' : 'DBS2' })),
      },
    });
    const res = await run('joining_next_week_preboarding_incomplete', {}, c);
    assert.equal(res.status, 'ok');
    assert.equal(res.total, 1);
    assert.equal(res.atLeast, false);
    assert.deepEqual(res.window, { from: '2026-10-05', to: '2026-10-11' });
    assert.deepEqual(res.rows, [{
      name: 'Asha Rao', employeeId: 'DBS1', joiningDate: '2026-10-06', placementStatus: 'Pending', preBoardingStatus: 'In Progress',
    }]);
    assert.ok(runCrossCheck.render(res).blocks[0].rows.length === 1);
  });

  it('passed interview minus offers, keyed by application; interviews with no application link are unmapped', async () => {
    const c = ctxFor(ALL, {
      models: {
        Meeting: () => [
          { applicationId: A(1), scheduledAt: new Date('2026-09-20T05:00:00Z'), jobPosition: 'SDR', interviewResult: 'selected' },
          { applicationId: A(2), scheduledAt: new Date('2026-09-21T05:00:00Z'), jobPosition: 'AE', interviewResult: 'selected' },
          { scheduledAt: new Date('2026-09-22T05:00:00Z'), interviewResult: 'selected' },
        ],
        Offer: (f) => {
          assert.deepEqual(inIds(clauseOf(f), 'jobApplication').sort(), [A(1), A(2)].sort());
          return [{ jobApplication: A(2), status: 'Draft' }];
        },
        JobApplication: (f) => inIds(f).map((x) => ({ _id: x, candidate: { fullName: 'Meera', employeeId: 'DBS7' }, job: { title: 'SDR' } })),
      },
    });
    const res = await run('passed_interview_no_offer', {}, c);
    assert.equal(res.total, 1);
    assert.equal(res.rows[0].name, 'Meera');
    assert.equal(res.rows[0].job, 'SDR');
    assert.equal(res.rows[0].interviewOn, '2026-09-20');
    assert.ok(res.notes.some((n) => /1 record\(s\) could not be linked/.test(n)));
  });

  it('bench matches: newest jobs → profile matches ∩ unallocated (no project, no open task)', async () => {
    const calls = [];
    const c = ctxFor(ALL, {
      deps: {
        runTool: async (name, args) => {
          calls.push({ name, args });
          if (name === 'list_jobs') return { status: 'ok', result: { jobs: [{ jobId: id(9001), title: 'React Dev' }, { jobId: id(9002), title: 'Node Dev' }] } };
          if (args.jobId === id(9001)) return { status: 'ok', result: { candidates: [{ userId: U(1), matchPct: 80 }, { userId: U(2), matchPct: 60 }] } };
          return { status: 'ok', result: { candidates: [{ userId: U(1), matchPct: 70 }, { userId: U(3), matchPct: 90 }] } };
        },
        countActiveProjects: async () => new Map([[U(1), 0], [U(2), 0], [U(3), 1]]),
      },
      models: {
        Employee: (f) => (f.population ? [{ owner: U(1) }, { owner: U(2) }, { owner: U(3) }]
          : inIds(f, 'owner').map((o) => ({ owner: o, fullName: `P${o.slice(-1)}` }))),
        Task: () => [{ assignedTo: [U(2)], title: 'Fix bug' }],
        User: () => [],
      },
    });
    const res = await run('bench_matches_recent_jobs', { jobKeyword: 'dev', jobCount: 2 }, c);
    assert.deepEqual(calls[0], { name: 'list_jobs', args: { filters: { search: 'dev' }, limit: 2 } });
    assert.equal(calls.filter((x) => x.name === 'match_candidates_to_job').length, 2);
    assert.equal(res.total, 1);
    assert.equal(res.rows[0].matchPct, 80);
    assert.equal(res.rows[0].jobsMatched, 2);
    assert.equal(res.jobs.length, 2);
  });

  it('referred + screened minus interviewed; sales agent "me" needs no lookup', async () => {
    const c = ctxFor(ALL, {
      deps: { canSeeAllReferralLeads: async () => false },
      models: {
        JobApplication: () => [
          { _id: A(1), candidate: E(1), job: id(9001), status: 'Screening' },
          { _id: A(2), candidate: E(2), job: id(9001), status: 'Shortlisted' },
          { _id: A(3), candidate: E(3), job: id(9001), status: 'Screening' },
        ],
        Employee: (f) => {
          if (f.referredByUserId) {
            assert.equal(f.currentSalesAgentUserId, id(1));
            assert.ok(f.$or);
            return [{ _id: E(1) }, { _id: E(2) }];
          }
          return inIds(f).map((x) => ({ _id: x, fullName: `Lead ${x.slice(-1)}` }));
        },
        Meeting: (f) => {
          const [byId, byText] = clauseOf(f).$or;
          assert.deepEqual(inIds(byId, 'candidateId').sort(), [E(1), E(2)].sort());
          assert.deepEqual(inIds(byText, 'candidate.id').sort(), [E(1), E(2)].sort());
          // Linked by candidateId only (candidate.id is a mock id): still counts as interviewed.
          return [{ candidateId: E(2), candidate: { id: '1' } }];
        },
        Job: () => [{ _id: id(9001), title: 'SDR' }],
      },
    });
    const res = await run('referred_screened_never_interviewed', { salesAgent: 'me' }, c);
    assert.equal(res.total, 1);
    assert.deepEqual(res.rows[0], { name: 'Lead 1', applicationStatus: 'Screening', job: 'SDR' });
    assert.equal(res.salesAgent, 'Viewer');
  });

  it('a viewer scoped to own referral leads cannot name another sales agent', async () => {
    const c = ctxFor(ALL, { deps: { canSeeAllReferralLeads: async () => false } });
    const res = await run('referred_screened_never_interviewed', { salesAgent: 'Someone Else' }, c);
    assert.match(res.error, /own referral leads/);
  });
});

describe('run_cross_check — section statuses', () => {
  it('restricted: a viewer without placement access gets the section NAME only, no data', async () => {
    const c = ctxFor(['evaluation.read']);
    const res = await run('joining_next_week_preboarding_incomplete', {}, c);
    assert.equal(res.status, 'restricted');
    assert.ok(!('rows' in res) && !('total' in res));
    assert.ok(res.sections.every((s) => s.status === 'restricted' && !('total' in s)));
    assert.match(res.note, /Placements joining next week/);
  });

  it('restricted on ONE side fails the whole check — the other side is never shown', async () => {
    const c = ctxFor(['candidates.read'], {
      models: { Placement: () => [{ candidate: E(1), status: 'Joined' }], Employee: () => [{ _id: E(1), owner: U(1) }] },
    });
    const res = await run('onboarded_no_course', {}, c);
    assert.equal(res.status, 'restricted');
    assert.deepEqual(res.sections.map((s) => s.section), ['Training evaluation']);
    assert.ok(!('rows' in res));
  });

  it('notCaptured: attendance for a day not yet recorded', async () => {
    const c = ctxFor(ALL, {
      deps: { runTool: async () => ({ status: 'ok', result: { futureDate: true, note: 'Attendance is only recorded for days that have already happened.' } }) },
    });
    const res = await run('absent_today_tasks_due_today', {}, c);
    assert.equal(res.status, 'notCaptured');
    assert.match(res.sections[0].reason, /already happened/);
  });

  it('error and timeout from a composed section are reported, not filled from elsewhere', async () => {
    const err = await run('not_punched_in_with_meeting_today', {}, ctxFor(ALL, { deps: { runTool: async () => ({ status: 'error', error: 'boom' }) } }));
    assert.equal(err.status, 'error');
    assert.equal(err.sections[0].reason, 'boom');
    const slow = await run('absent_today_tasks_due_today', {}, ctxFor(ALL, { deps: { runTool: async () => ({ status: 'timeout' }) } }));
    assert.equal(slow.status, 'timeout');
  });

  it('restricted composed tool (attendance summary) → restricted check', async () => {
    const res = await run('absent_today_tasks_due_today', {}, ctxFor(ALL, { deps: { runTool: async () => ({ status: 'restricted' }) } }));
    assert.equal(res.status, 'restricted');
    assert.match(res.note, /Absent today/);
  });

  it('tasks need the org-wide board (tasks.read), otherwise restricted', async () => {
    const c = ctxFor(['projects.read', 'employees.read'], {
      deps: { countActiveProjects: async () => new Map([[U(1), 2]]) },
      models: { Employee: () => [{ owner: U(1) }] },
    });
    const res = await run('two_projects_overdue_tasks', {}, c);
    assert.equal(res.status, 'restricted');
    assert.deepEqual(res.sections.map((s) => s.section), ['Overdue tasks']);
  });

  it('no_reporting_manager composes get_reporting_chain and passes its rows and note through', async () => {
    const ok = await run('no_reporting_manager', {}, ctxFor(ALL, {
      deps: { runTool: async (name, args) => ({ status: 'ok', result: { total: 2, totalActiveEmployees: 9, records: [{ name: 'A' }], note: 'RM not captured', args } }) },
    }), 1);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.total, 2);
    assert.equal(ok.composedFrom, 'get_reporting_chain');
    assert.deepEqual(ok.notes, ['RM not captured']);
    const denied = await run('no_reporting_manager', {}, ctxFor([], { deps: { runTool: async () => ({ status: 'restricted' }) } }));
    assert.equal(denied.status, 'restricted');
  });
});

describe('run_cross_check — set logic edge cases', () => {
  it('empty first set → total 0 and the second set is never queried', async () => {
    const c = ctxFor(ALL);
    const res = await run('on_project_no_active_tasks', {}, c);
    assert.equal(res.status, 'ok');
    assert.equal(res.total, 0);
    assert.deepEqual(res.rows, []);
    assert.ok(!c.log.some((l) => l.model === 'Task'));
  });

  it('duplicate names are both listed, told apart by employeeId', async () => {
    const c = ctxFor(ALL, {
      deps: { countActiveProjects: async () => new Map([[U(1), 2], [U(2), 3]]) },
      models: {
        Employee: (f) => (f.population ? [{ owner: U(1) }, { owner: U(2) }]
          : [{ owner: U(1), fullName: 'Ravi Kumar', employeeId: 'DBS1' }, { owner: U(2), fullName: 'Ravi Kumar', employeeId: 'DBS2' }]),
        Task: () => [{ assignedTo: [U(1), U(2)], title: 'Late thing' }],
        User: () => [],
      },
    });
    const res = await run('two_projects_overdue_tasks', {}, c);
    assert.equal(res.total, 2);
    assert.deepEqual(res.rows.map((r) => r.employeeId).sort(), ['DBS1', 'DBS2']);
    assert.ok(res.notes.some((n) => /share a name/.test(n)));
  });

  it('a person with no Employee profile keeps their login name and is flagged', async () => {
    const c = ctxFor(ALL, {
      models: {
        LeaveRequest: () => [{ student: S(1), leaveType: 'sick' }],
        Student: () => [{ _id: S(1), user: U(9) }],
        InternalMeeting: () => [{ title: 'Standup', createdBy: U(9), hosts: [], emailInvites: ['guest@outside.com'] }],
        Meeting: () => [],
        Employee: () => [],
        User: (f) => (f.email ? [] : [{ _id: U(9), name: 'Temp Login' }]),
      },
    });
    const res = await run('on_leave_tomorrow_with_interview_or_meeting', {}, c);
    assert.equal(res.total, 1);
    assert.deepEqual(res.rows[0], { name: 'Temp Login', employeeProfile: false, leaveType: 'sick', meetings: 1, examples: ['Standup (meeting)'] });
    assert.ok(res.notes.some((n) => /could not be linked/.test(n)), 'external invitee counted as unmapped');
  });

  it('unmapped people (profile with no login) are counted, never silently dropped', async () => {
    const c = ctxFor(ALL, {
      models: {
        Placement: () => [{ candidate: E(1), status: 'Joined' }, { candidate: E(3), status: 'Joined' }],
        Employee: (f) => (f._id ? [{ _id: E(1), owner: U(1) }, { _id: E(3) }] : [{ owner: U(1) }]),
        Student: () => [{ _id: S(1), user: U(1) }],
        User: () => [],
      },
      deps: { getEvaluationData: async () => ({ evaluations: [{ studentId: S(1), courseName: 'Onboarding 101', displayStatus: 'In Progress' }] }) },
    });
    const res = await run('onboarded_no_course', {}, c);
    assert.equal(res.total, 0);
    assert.equal(res.sets[0].unmapped, 1);
    assert.ok(res.notes.some((n) => /1 record\(s\) could not be linked/.test(n)));
  });

  it('a truncated set makes the answer "at least"; unchanged applications report their date basis', async () => {
    const many = Array.from({ length: SET_CAP + 1 }, (_, i) => ({
      _id: id(50000 + i).slice(-24), job: id(9001), status: 'Applied',
      ...(i % 2 ? {} : { statusChangedAt: new Date('2026-09-01T00:00:00Z') }),
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-09-02T00:00:00Z'),
    }));
    let seenCutoff = null;
    const c = ctxFor(ALL, {
      deps: {
        runTool: async (name, args) => {
          assert.equal(name, 'list_holidays');
          assert.equal(args.scope, 'company');
          return { status: 'ok', result: { holidays: [{ title: 'Festival', date: '2026-09-25' }] } };
        },
      },
      models: {
        JobApplication: (f) => {
          if (f._id) return [];
          const unchanged = clauseOf(f).$and[1];
          seenCutoff = unchanged.$or[0].statusChangedAt.$lte;
          return many;
        },
        Job: () => [{ _id: id(9001), title: 'SDR' }],
      },
    });
    const res = await run('applications_unchanged', { businessDays: 5 }, c);
    assert.equal(res.atLeast, true);
    assert.equal(res.total, SET_CAP);
    assert.equal(res.rows.length, 20);
    assert.equal(res.noChangeSince, '2026-09-22');
    assert.equal(res.holidaysSkipped, 1);
    assert.equal(seenCutoff.toISOString(), '2026-09-21T18:29:59.999Z');
    assert.deepEqual(res.basis, { statusChangedAt: 2500, createdAt: 2500 });
    assert.ok(res.rows.every((r) => ['statusChangedAt', 'createdAt'].includes(r.lastChangeBasis)));
    assert.match(runCrossCheck.render(res).blocks[0].title, /at least 5000/);
  });

  it('holidays the viewer cannot read are not skipped, and the answer says so', async () => {
    const c = ctxFor(ALL, {
      deps: { runTool: async () => ({ status: 'ok', result: { error: 'needs students.read' } }) },
      models: { JobApplication: () => [] },
    });
    const res = await run('applications_unchanged', {}, c);
    assert.equal(res.noChangeSince, '2026-09-23');
    assert.equal(res.holidaysSkipped, null);
    assert.ok(res.notes.some((n) => /holidays were not skipped/.test(n)));
  });

  it('available with training score: skill narrows courses, highest score first', async () => {
    const c = ctxFor(ALL, {
      deps: {
        countActiveProjects: async () => new Map([[U(1), 0], [U(2), 0], [U(3), 1]]),
        getEvaluationData: async () => ({
          evaluations: [
            { studentId: S(1), courseName: 'React Basics', quizScore: 75, displayStatus: 'Completed' },
            { studentId: S(2), courseName: 'React Advanced', quizScore: 92, displayStatus: 'Completed' },
            { studentId: S(3), courseName: 'React Basics', quizScore: 99, displayStatus: 'Completed' },
            { studentId: S(1), courseName: 'Excel', quizScore: 100, displayStatus: 'Completed' },
          ],
        }),
      },
      models: {
        Employee: (f) => (f.population ? [{ owner: U(1) }, { owner: U(2) }, { owner: U(3) }] : []),
        Student: () => [{ _id: S(1), user: U(1) }, { _id: S(2), user: U(2) }, { _id: S(3), user: U(3) }],
        User: () => [{ _id: U(1), name: 'One' }, { _id: U(2), name: 'Two' }],
      },
    });
    const res = await run('available_with_training_score', { skill: 'react', minScore: 70 }, c);
    assert.equal(res.total, 2);
    assert.deepEqual(res.rows.map((r) => [r.name, r.quizScore]), [['Two', 92], ['One', 75]]);
    assert.equal(res.minScore, 70);
  });
});
