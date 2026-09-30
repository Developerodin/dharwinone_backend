import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import runDataQualityChecks from '../runDataQualityChecks.tool.js';
import { CHECK_IDS } from '../qualityChecks.js';

const UID = '64b0000000000000000000a1';
const viewer = (...perms) => ({ id: UID, _id: UID, name: 'Asha', authContext: { permissions: new Set(perms) } });
const FULL = viewer('employees.read', 'candidates.read', 'offers.read', 'offers.edit', 'projects.read', 'tasks.read', 'modules.read');
const NONE = viewer('dashboard.view');

const ok = (result) => ({ status: 'ok', result });

/** Chainable Mongoose-query fake: select / sort / populate pass through, limit caps, lean / distinct resolve. */
function query(rows, seen) {
  const q = {
    select: (s) => { if (seen) seen.select = s; return q; },
    sort: () => q,
    populate: () => q,
    limit: (n) => { q.n = n; return q; },
    lean: async () => rows.slice(0, q.n ?? rows.length),
    distinct: async (f) => rows.map((r) => r[f]),
  };
  return q;
}

function fakeDeps(over = {}) {
  const seen = { employeeMatches: [], auth: [], scope: [], offerMatches: [], projectFilter: null, runTool: [] };
  // Two people who own their own profiles, plus recruiter REC who owns their own profile AND a public-apply
  // candidate's. Every scan returns all four; ownsProfile decides who is who.
  const peopleRows = [
    { _id: 'e1', owner: 'o1', email: 'ravi1@x.com', fullName: 'Ravi Kumar', employeeId: 'E1', isProfileCompleted: 60 },
    { _id: 'e2', owner: 'o2', email: 'ravi2@x.com', fullName: 'Ravi Kumar', employeeId: 'E2', isProfileCompleted: 40 },
    { _id: 'e3', owner: 'REC', email: 'meera@x.com', fullName: 'Meera Iyer', employeeId: null },
    { _id: 'e4', owner: 'REC', email: 'rec@x.com', fullName: 'Rec Ruiter', employeeId: 'E4' },
  ];
  const deps = {
    now: () => new Date('2026-09-30T06:00:00.000Z'),
    authorizeEmployeeQuery: (q) => { seen.auth.push(q); return { allowed: true }; },
    applyEmployeeListScope: async (f) => { seen.scope.push(f); return { ...f, scoped: true }; },
    buildEmployeeListMongoFilter: async (f) => ({ mongoFilter: { owner: { role: f.ownerUserRole }, scoped: f.scoped } }),
    Employee: {
      find: (m) => {
        if (m.referredByUserId) return query([{ _id: 'cand1' }]);
        if (m.owner?.$in) return query(peopleRows.filter((r) => m.owner.$in.includes(r.owner)));
        seen.employeeMatches.push(m);
        return query(peopleRows);
      },
    },
    User: { find: () => query([{ _id: 'REC', email: 'rec@x.com' }]) },
    JobApplication: {
      countDocuments: async (m) => { seen.applicationMatch = m; return 2; },
      find: () => query([
        { candidate: { fullName: 'Meera Iyer' }, job: { title: 'Nurse' }, status: 'Applied' },
        { candidate: null, job: { title: 'Nurse' }, status: 'Applied' },
      ]),
    },
    buildApplicantQuery: async (filter, user) => ({ query: { scopedFor: user.id, excludeInternal: filter.excludeInternal } }),
    Offer: {
      countDocuments: async (m) => {
        seen.offerMatches.push(m);
        const c = m.$and[2];
        if (c.$or && c.$or[0].joiningDate === null) return 7;
        return c.joiningDate === null ? 4 : 5;
      },
      find: () => query([
        { offerCode: 'OF-1', status: 'Sent', joiningDate: null, compensationType: 'paid', ctcBreakdown: { gross: 0 }, candidate: { fullName: 'Kiran' } },
        { offerCode: 'OF-2', status: 'Draft', joiningDate: new Date(), compensationType: 'unpaid', ctcBreakdown: { gross: 0 }, candidate: null },
      ]),
    },
    buildOfferVisibilityClause: async () => ({ unrestricted: true }),
    canSeeOfferCompensation: async (u) => !!u.authContext.permissions.has('offers.edit'),
    TrainingModule: {
      countDocuments: async () => 2,
      find: () => query([{ moduleName: 'Safety 101', status: 'published' }, { moduleName: 'Draft course', status: 'draft' }]),
    },
    isAdmin: async () => false,
    queryProjects: async (filter, opts) => {
      seen.projectFilter = filter;
      return { totalResults: 1, results: [{ name: 'Apollo', status: 'Active' }].slice(0, opts.limit) };
    },
    runTool: async (name, args) => {
      seen.runTool.push({ name, args });
      const o = over.tools?.[name];
      if (typeof o === 'function') return o(args);
      if (o) return o;
      if (name === 'find_duplicate_people') {
        return ok({
          by: args.by, population: args.population, totalGroups: 9, byField: { [args.by]: 9 }, truncated: true,
          groups: [
            { matchedOn: args.by, value: 'x', size: 2, people: [{ id: 'p1', name: 'Anu' }, { id: 'p2', name: null }] },
            { matchedOn: args.by, value: 'y', size: 2, people: [] },
          ],
          ...(args.by === 'email' ? { emailNote: 'Profile emails are stored lower-case and unique.' } : {}),
        });
      }
      if (name === 'list_interviews') return ok({ total: 3, records: [{ candidate: 'Sam', jobPosition: 'Nurse', scheduledAt: '2026-09-20T09:00:00Z' }] });
      if (name === 'count_employees') return ok({ total: 50, groups: [{ value: 'Nursing', count: 40 }, { value: 'Not set', count: 10 }] });
      if (name === 'get_reporting_chain') return ok({ total: 4, totalActiveEmployees: 50, records: [{ name: 'Ravi Kumar', designation: 'RN' }] });
      if (name === 'get_training_progress') return ok({ total: 9, records: [] });
      if (name === 'list_tasks') return ok({ total: 2, scope: 'all', records: [{ code: 'T-1', title: 'Fix', status: 'todo', assignees: ['x'] }] });
      if (name === 'list_documents') {
        return ok({
          total: 2,
          records: [
            { name: 'Lina', employeeId: 'E9', expiries: [{ document: 'EAD', expiresOn: '2026-09-01', expired: true }] },
            { name: 'Tom', employeeId: 'E8', expiries: [{ document: 'Visa', expiresOn: '2026-10-01', expired: false, expiringSoon: true }] },
          ],
        });
      }
      return { status: 'unknown', error: `unknown tool ${name}` };
    },
    ...over.deps,
  };
  return { deps, seen };
}

const run = async (args, user = FULL, over = {}) => {
  const { deps, seen } = fakeDeps(over);
  const out = await runDataQualityChecks.execute(args, { user, requestId: 'r', deps });
  return { out, seen, check: (id) => out.checks.find((c) => c.id === id) };
};

describe('run_data_quality_checks', () => {
  it('happy path: all 17 checks, each { id, label, status, count, sample, source }', async () => {
    const { out, check } = await run({});
    assert.equal(out.checks.length, 17);
    assert.deepEqual(out.checks.map((c) => c.id), CHECK_IDS);
    for (const c of out.checks) {
      for (const k of ['id', 'label', 'status', 'count', 'sample', 'source']) assert.ok(k in c, `${c.id} missing ${k}`);
      assert.equal(c.status, 'ok', `${c.id}: ${c.error}`);
      assert.ok(c.sample.length <= 5);
    }
    // Employee checks: the recruiter's own profile counts, the applicant they merely own does not.
    assert.equal(check('incomplete_employee_profiles').count, 3);
    // Candidate checks: the recruiter-owned applicant is added back.
    assert.equal(check('candidates_no_skills').count, 4);
    assert.equal(check('employees_no_agent').count, 3);
    assert.equal(check('employees_no_department').count, 10);
    assert.equal(check('employees_no_group').count, 4);
    assert.equal(check('courses_no_position').count, 2);
    assert.equal(check('projects_no_manager').count, 1);
    assert.equal(out.flagged, 17);
    assert.deepEqual(out.restricted, []);
  });

  it("people checks use the page's own scope + one $and clause, with the right role", async () => {
    const { seen, check } = await run({ checks: ['incomplete_employee_profiles', 'candidates_no_education'] });
    const [emp, cand, candNoRole] = seen.employeeMatches;
    assert.deepEqual(emp, { $and: [{ owner: { role: 'employee' }, scoped: true }, { isProfileCompleted: { $not: { $gte: 100 } } }] });
    assert.deepEqual(cand, { $and: [{ owner: { role: 'candidate' }, scoped: true }, { 'qualifications.0': { $exists: false } }] });
    assert.deepEqual(candNoRole, { $and: [{ scoped: true }, { 'qualifications.0': { $exists: false } }] }, 'same scope, role clause dropped');
    assert.equal(seen.employeeMatches.length, 3, 'employee checks never add recruiter-owned applicants');
    assert.deepEqual(seen.auth.map((a) => a.filters.ownerUserRole).sort(), ['candidate', 'employee']);
    assert.deepEqual(check('incomplete_employee_profiles').sample[0], { name: 'Ravi Kumar', employeeId: 'E1', profileCompletion: 60 });
    assert.match(check('incomplete_employee_profiles').source, /calculateProfileCompletion/);
  });

  it('duplicate names in a sample stay as separate rows', async () => {
    const { check } = await run({ checks: ['candidates_no_skills'] });
    assert.deepEqual(check('candidates_no_skills').sample.map((s) => s.name).filter((n) => n === 'Ravi Kumar'), ['Ravi Kumar', 'Ravi Kumar']);
  });

  it('access denied: a viewer with none of the page permissions gets restricted checks with no data', async () => {
    const { out } = await run({}, NONE, {
      tools: {
        find_duplicate_people: { status: 'restricted' },
        list_interviews: { status: 'restricted' },
        count_employees: { status: 'restricted' },
        get_reporting_chain: { status: 'restricted' },
        get_training_progress: ok({ error: 'Not allowed: requires students.read' }),
        list_tasks: ok({ total: 0, scope: 'mine', records: [] }),
        list_documents: ok({ error: 'You can only see your own documents.' }),
      },
    });
    const restricted = out.checks.filter((c) => c.status === 'restricted').map((c) => c.id);
    assert.deepEqual(restricted.sort(), CHECK_IDS.filter((id) => id !== 'tasks_no_due_date').sort());
    for (const c of out.checks.filter((x) => x.status === 'restricted')) {
      assert.equal(c.count, null);
      assert.deepEqual(c.sample, []);
    }
    assert.equal(out.checks.find((c) => c.id === 'tasks_no_due_date').scope, 'mine');
  });

  it('offers: without the compensation permission the salary half is restricted and count is joining-date only', async () => {
    const plain = viewer('offers.read');
    const { check, seen } = await run({ checks: ['offers_missing_terms'] }, plain);
    const c = check('offers_missing_terms');
    assert.equal(c.count, 4);
    assert.deepEqual(c.parts, { missingJoiningDate: 4, missingSalary: 'restricted' });
    assert.ok(seen.offerMatches.every((m) => !JSON.stringify(m).includes('ctcBreakdown')));
    assert.equal(c.sample[0].missing, 'joining date');
  });

  it('offers: a compensation viewer gets both parts, unpaid offers never count as missing salary', async () => {
    const { check, seen } = await run({ checks: ['offers_missing_terms'] });
    const c = check('offers_missing_terms');
    assert.equal(c.count, 7);
    assert.deepEqual(c.parts, { missingJoiningDate: 4, missingSalary: 5 });
    assert.deepEqual(seen.offerMatches[0].$and[1], { status: { $nin: ['Rejected', 'Draft'] } }, 'drafts are still being written');
    assert.equal(c.sample[0].missing, 'joining date, salary');
    assert.equal(c.sample[1].missing, '');
  });

  it("offers: a creator-scoped viewer is filtered by the Offers page's own visibility; blocked → 0", async () => {
    const { seen } = await run({ checks: ['offers_missing_terms'] }, FULL, {
      deps: { buildOfferVisibilityClause: async () => ({ createdBy: UID }) },
    });
    assert.ok(seen.offerMatches.every((m) => m.$and[0].createdBy === UID));
    const { check } = await run({ checks: ['offers_missing_terms'] }, FULL, {
      deps: { buildOfferVisibilityClause: async () => ({ blocked: true }) },
    });
    assert.equal(check('offers_missing_terms').count, 0);
  });

  it('applications with no referral: a candidate with no Employee profile counts as missing and shows no name', async () => {
    const { check } = await run({ checks: ['applications_no_referral'] });
    const c = check('applications_no_referral');
    assert.equal(c.count, 2);
    assert.equal(c.sample[1].applicant, undefined);
    assert.match(c.source, /not captured in DharwinOne/);
  });

  it('applications with no referral: counted in Mongo within the page scope, never loading every application', async () => {
    const { seen } = await run({ checks: ['applications_no_referral'] });
    assert.deepEqual(seen.applicationMatch, { $and: [{ scopedFor: UID, excludeInternal: true }, { candidate: { $nin: ['cand1'] } }] });
  });

  it('duplicates come from find_duplicate_people; an unregistered tool is an error, never another source', async () => {
    const { check, seen } = await run({ checks: ['duplicate_phones', 'duplicate_emails'] });
    assert.deepEqual(seen.runTool.map((c) => c.args.by).sort(), ['email', 'phone']);
    assert.deepEqual(seen.runTool.map((c) => c.args.population), ['all', 'all']);
    assert.equal(check('duplicate_phones').count, 9, 'totalGroups, not the listed groups');
    assert.deepEqual(check('duplicate_phones').sample[0], { matchedOn: 'phone', people: 'Anu, (no name)' });
    assert.match(check('duplicate_emails').note, /lower-case/);
    const shapeless = await run({ checks: ['duplicate_phones'] }, FULL, { tools: { find_duplicate_people: ok({ groups: [] }) } });
    assert.equal(shapeless.check('duplicate_phones').status, 'error');
    const missing = await run({ checks: ['duplicate_emails'] }, FULL, { tools: { find_duplicate_people: { status: 'unknown', error: 'unknown tool' } } });
    assert.equal(missing.check('duplicate_emails').status, 'error');
    assert.equal(missing.check('duplicate_emails').count, null);
  });

  it('employees with no department: a breakdown cut at 25 groups is an error, not 0', async () => {
    const { check } = await run({ checks: ['employees_no_department'] }, FULL, {
      tools: { count_employees: ok({ total: 99, groups: [{ value: 'A', count: 90 }], otherCount: 9 }) },
    });
    assert.equal(check('employees_no_department').status, 'error');
    const none = await run({ checks: ['employees_no_department'] }, FULL, { tools: { count_employees: ok({ total: 5, groups: [{ value: 'A', count: 5 }] }) } });
    assert.equal(none.check('employees_no_department').count, 0);
  });

  it('tasks with no assignee needs the org-wide board: a self-scoped result is restricted', async () => {
    const { check } = await run({ checks: ['tasks_no_assignee'] }, FULL, { tools: { list_tasks: ok({ total: 0, scope: 'mine', records: [] }) } });
    assert.equal(check('tasks_no_assignee').status, 'restricted');
  });

  it('projects with no manager: Projects-page filter plus one projectManager clause', async () => {
    const { seen, check } = await run({ checks: ['projects_no_manager'] });
    assert.deepEqual(seen.projectFilter.projectManager, { $in: [null, ''] });
    assert.equal(check('projects_no_manager').scope, 'all');
  });

  it('courses: without the course list permission (modules / categories / positions read) → restricted', async () => {
    let read = false;
    // candidates.read grants positions.read (the Positions roster), so only an employees.read viewer is refused.
    const recruiter = viewer('employees.read');
    const { check } = await run({ checks: ['courses_no_position'] }, recruiter, {
      deps: { TrainingModule: { countDocuments: async () => { read = true; return 0; }, find: () => query([]) } },
    });
    assert.equal(check('courses_no_position').status, 'restricted');
    assert.equal(read, false);
  });

  it('courses: the roster gate refuses → restricted and the catalogue is never read', async () => {
    let read = false;
    const { check } = await run({ checks: ['courses_no_position'] }, FULL, {
      tools: { get_training_progress: ok({ error: 'Not allowed: requires students.read' }) },
      deps: { TrainingModule: { countDocuments: async () => { read = true; return 0; }, find: () => query([]) } },
    });
    assert.equal(check('courses_no_position').status, 'restricted');
    assert.equal(read, false);
  });

  it('expired documents: only people with an already-expired EAD / visa; a truncated scan is a lower bound', async () => {
    const { check } = await run({ checks: ['expired_documents'] });
    const c = check('expired_documents');
    assert.equal(c.count, 1);
    assert.deepEqual(c.sample, [{ name: 'Lina', employeeId: 'E9', expired: 'EAD 2026-09-01' }]);
    assert.equal(c.atLeast, undefined);
    const big = await run({ checks: ['expired_documents'] }, FULL, {
      tools: { list_documents: ok({ total: 80, scanTruncated: true, records: [] }) },
    });
    assert.equal(big.check('expired_documents').atLeast, true);
    assert.equal(runDataQualityChecks.render(big.out).blocks[0].rows[0].count, '0+');
  });

  it('one check throwing or timing out does not sink the others', async () => {
    const { out, check } = await run({ checks: ['interviews_no_result', 'employees_no_agent', 'tasks_no_due_date'] }, FULL, {
      tools: { list_interviews: { status: 'timeout' } },
      deps: { authorizeEmployeeQuery: () => { throw new Error('scope exploded'); } },
    });
    assert.equal(check('interviews_no_result').status, 'timeout');
    assert.equal(check('employees_no_agent').status, 'error');
    assert.equal(check('employees_no_agent').error, 'scope exploded');
    assert.equal(check('tasks_no_due_date').status, 'ok');
    assert.equal(out.failed.length, 2);
  });

  it('checks subset and sampleSize 0 → counts only, no sample queries', async () => {
    const { out } = await run({ checks: ['candidates_no_experience'], sampleSize: 0 });
    assert.equal(out.checks.length, 1);
    assert.equal(out.checks[0].count, 4);
    assert.deepEqual(out.checks[0].sample, []);
  });

  it('input schema: unknown / duplicate check ids and sampleSize over 5 are rejected', () => {
    assert.ok(runDataQualityChecks.input.validate({ checks: ['nope'] }).error);
    assert.ok(runDataQualityChecks.input.validate({ checks: ['duplicate_emails', 'duplicate_emails'] }).error);
    assert.ok(runDataQualityChecks.input.validate({ checks: [] }).error);
    assert.ok(runDataQualityChecks.input.validate({ sampleSize: 6 }).error);
    assert.equal(runDataQualityChecks.input.validate({}).value.sampleSize, 5);
  });
});
