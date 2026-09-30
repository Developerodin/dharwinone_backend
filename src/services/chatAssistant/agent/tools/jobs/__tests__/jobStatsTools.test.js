import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import getJob, { payLabel } from '../getJob.tool.js';
import getJobStats, { POOL_MAX } from '../getJobStats.tool.js';
import { recentCutoff, vacancyFacts, daysBetween, hireFactsForJobs } from '../jobStats.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const VIS = { createdBy: 'user-1' };
const USER = { id: 'user-1', roleIds: [], authContext: { permissions: new Set(['jobs.read']) } };
const JOB_ID = '64b7f0c2a1b2c3d4e5f60718';
const JOB_2 = '64b7f0c2a1b2c3d4e5f60719';
const JOB_3 = '64b7f0c2a1b2c3d4e5f6071a';
const NOW = new Date('2026-09-30T06:30:00.000Z'); // 12:00 IST

function contains(filter, clause) {
  if (isDeepStrictEqual(filter, clause)) return true;
  if (Array.isArray(filter)) return filter.some((f) => contains(f, clause));
  if (filter && typeof filter === 'object' && !(filter instanceof RegExp)) {
    return Object.values(filter).some((v) => contains(v, clause));
  }
  return false;
}

/** Fake Job model: findOne → `one`, find → `docs`, countDocuments → `count`; every filter is recorded. */
function fakeJob({ one = null, docs = [], count = docs.length } = {}) {
  const calls = { findOne: [], find: [], countDocuments: [], limit: [], sort: [] };
  const chain = (result) => {
    const q = {
      select: () => q,
      populate: () => q,
      sort: (s) => { calls.sort.push(s); return q; },
      limit: (n) => { calls.limit.push(n); return q; },
      lean: async () => result,
    };
    return q;
  };
  return {
    calls,
    Job: {
      findOne: (f) => { calls.findOne.push(f); return chain(one); },
      find: (f) => { calls.find.push(f); return chain(docs); },
      countDocuments: async (f) => { calls.countDocuments.push(f); return count; },
    },
  };
}

function ctxFor(Job, deps = {}, user = USER) {
  return {
    user,
    requestId: 'req-1',
    deps: { Job, resolveJobVisibilityFilter: async () => VIS, now: () => NOW, ...deps },
  };
}

describe('get_job — creator, recruiter, deadline, pay, not-captured fields', () => {
  it('adds createdBy / recruiter / deadline read under visibility, and nulls project and visa', async () => {
    const deadline = new Date('2026-10-15T00:00:00.000Z');
    const { Job, calls } = fakeJob({
      one: { _id: JOB_ID, title: 'ML Engineer', status: 'Active', createdBy: { name: 'Asha' }, assignedRecruiter: { name: 'Ravi' }, applicationDeadline: deadline },
    });
    const out = await getJob.execute({ jobId: JOB_ID }, ctxFor(Job));
    assert.equal(out.job.createdBy, 'Asha');
    assert.equal(out.job.recruiter, 'Ravi');
    assert.equal(out.job.recruiterName, 'Ravi', 'mapJobRow recruiterName must not contradict recruiter');
    assert.equal('recruiterNote' in out.job, false);
    assert.equal(out.job.applicationDeadline, deadline);
    assert.equal(out.job.project, null);
    assert.equal(out.job.workAuthorization, null);
    assert.match(out.job.notCaptured, /not captured in DharwinOne/);
    assert.equal(calls.findOne.length, 2);
    assert.ok(calls.findOne.every((f) => contains(f, VIS)), 'ownership read must keep the visibility clause');
  });

  it('missing creator / recruiter / deadline come back null, with the job-creator note for the recruiter', async () => {
    const { Job } = fakeJob({ one: { _id: JOB_ID, title: 'ML Engineer', status: 'Active' } });
    const out = await getJob.execute({ jobId: JOB_ID }, ctxFor(Job));
    assert.equal(out.job.createdBy, null);
    assert.equal(out.job.recruiter, null);
    assert.match(out.job.recruiterNote, /job creator/);
    assert.equal(out.job.applicationDeadline, null);
    assert.equal(out.job.pay, 'Not specified');
  });

  it('pay reads like the Jobs page Salary column: no range or 0 – 0 is "Not specified"', () => {
    assert.equal(payLabel(undefined), 'Not specified');
    assert.equal(payLabel({ min: 0, max: 0, currency: 'USD' }), 'Not specified');
    assert.equal(payLabel({ min: 50000, max: 80000, currency: 'USD' }), '$50,000 – $80,000');
  });

  it('adds pay from the salary range', async () => {
    const { Job } = fakeJob({ one: { _id: JOB_ID, title: 'ML Engineer', status: 'Active', salaryRange: { min: 10, max: 20, currency: 'USD' } } });
    const out = await getJob.execute({ jobId: JOB_ID }, ctxFor(Job));
    assert.equal(out.job.pay, '$10 – $20');
  });

  it('title is capped at 200 characters', () => {
    assert.ok(getJob.input.validate({ title: 'x'.repeat(201) }).error);
  });

  it('is denied without jobs.read', async () => {
    const denied = await checkAccessRule(getJob.access, { id: 'u', authContext: { permissions: new Set(['candidates.read']) } });
    assert.equal(denied.ok, false);
  });
});

describe('get_job_stats — access and fail closed', () => {
  it('needs jobs.read (the GET /jobs/:jobId/stats route permission)', async () => {
    assert.deepEqual(getJobStats.access, { anyOf: ['jobs.read'] });
    assert.equal((await checkAccessRule(getJobStats.access, { id: 'u', authContext: { permissions: new Set() } })).ok, false);
    assert.equal((await checkAccessRule(getJobStats.access, USER)).ok, true);
  });

  it('refuses to run without a user id', async () => {
    const { Job, calls } = fakeJob();
    await assert.rejects(() => getJobStats.execute({}, ctxFor(Job, {}, {})), /user with an id/);
    assert.equal(calls.find.length + calls.findOne.length, 0);
  });
});

describe('get_job_stats — one job', () => {
  const job = {
    _id: JOB_ID, title: 'ML Engineer', status: 'Active', organisation: { name: 'Acme' },
    createdAt: new Date('2026-09-01T00:00:00.000Z'), vacancies: 2, applicationDeadline: null,
  };

  it('uses the Job analytics service with the viewer, the scoped interviewed count and job-level hires', async () => {
    const { Job, calls } = fakeJob({ one: job });
    const seen = [];
    const grouped = [];
    const out = await getJobStats.execute({ jobId: JOB_ID }, ctxFor(Job, {
      getJobStats: async (id, user) => {
        seen.push({ id, user });
        return {
          totalApplications: 5,
          funnel: [{ status: 'Applied', count: 3 }, { status: 'Interview', count: 0 }, { status: 'Hired', count: 2 }],
          recentApplications: [{ appliedAt: new Date('2026-09-28T00:00:00.000Z') }],
        };
      },
      aggregateApplicationsByJob: async (filter, user) => {
        grouped.push({ filter, user });
        return [{ jobId: JOB_ID, total: 5, byStage: {}, lastAppliedAt: null, interviewed: 2 }];
      },
      hireFactsForJobs: async () => new Map([[JOB_ID, { hired: 2, lastHiredAt: new Date('2026-09-21T00:00:00.000Z') }]]),
    }));
    assert.deepEqual(seen, [{ id: JOB_ID, user: USER }]);
    assert.deepEqual(grouped, [{ filter: { jobId: JOB_ID }, user: USER }], 'interviewed count uses the same viewer scope');
    assert.ok(contains(calls.findOne[0], VIS));
    assert.equal(out.applications.total, 5);
    assert.equal(out.applications.interviewed, 2);
    assert.deepEqual(out.applications.byStage, { Applied: 3, Interview: 0, Hired: 2 });
    assert.equal(out.applications.daysSinceLastApplication, 2);
    assert.equal(out.zeroApplications, false);
    assert.equal(out.applicationsButNoInterviews, false);
    assert.equal(out.hireRatePercent, 40);
    assert.equal(out.vacanciesLeft, 0);
    assert.equal(out.timeToFillDays, 20);
    assert.match(out.timeToFillBasis, /offer was accepted/);
    assert.match(out.hiredBasis, /every hire on the job/, 'job-level hired vs viewer-scoped hire rate is labelled');
    assert.match(out.closeSuggestion, /may want to close/);
    assert.equal(out.noApplicationsInLastDays.none, false);
  });

  it('missing data stays null: legacy uncapped job, no applications, no hires', async () => {
    const legacy = { ...job, vacancies: undefined };
    const { Job } = fakeJob({ one: legacy });
    const out = await getJobStats.execute({ jobId: JOB_ID }, ctxFor(Job, {
      getJobStats: async () => ({ totalApplications: 0, funnel: [], recentApplications: [] }),
      aggregateApplicationsByJob: async () => [],
      hireFactsForJobs: async () => new Map(),
    }));
    assert.equal(out.vacancies, null);
    assert.equal(out.vacanciesLeft, null);
    assert.equal(out.timeToFillDays, null);
    assert.equal(out.hireRatePercent, null);
    assert.equal(out.applications.lastApplicationAt, null);
    assert.equal(out.applications.daysSinceLastApplication, null);
    assert.equal(out.applications.interviewed, 0);
    assert.equal(out.zeroApplications, true);
    assert.equal(out.noApplicationsInLastDays.none, true);
    assert.equal(out.closeSuggestion, null);
  });

  it('a job outside the viewer\'s visibility is notFound and never reaches the stats service', async () => {
    const { Job } = fakeJob({ one: null });
    const out = await getJobStats.execute({ jobId: JOB_ID }, ctxFor(Job, {
      getJobStats: () => assert.fail('must not read stats for an invisible job'),
      aggregateApplicationsByJob: () => assert.fail('must not read applications for an invisible job'),
      hireFactsForJobs: () => assert.fail('must not read hires for an invisible job'),
    }));
    assert.deepEqual(out, { notFound: true });
  });
});

describe('get_job_stats — ranked across jobs', () => {
  const docs = [
    { _id: JOB_ID, title: 'Busy', status: 'Active', createdAt: new Date('2026-09-20T00:00:00.000Z'), vacancies: 3 },
    { _id: JOB_2, title: 'Empty', status: 'Active', createdAt: new Date('2026-06-01T00:00:00.000Z'), vacancies: 1 },
    { _id: JOB_3, title: 'Stalled', status: 'Active', createdAt: new Date('2026-08-01T00:00:00.000Z'), vacancies: 1,
      applicationDeadline: new Date('2026-09-01T00:00:00.000Z') },
  ];
  // Rows as applicantQuery.service aggregateApplicationsByJob returns them (already one per person per job).
  const grouped = [
    { jobId: JOB_ID, total: 2, byStage: { Interview: 1, Applied: 1 }, lastAppliedAt: new Date('2026-09-29T00:00:00.000Z'), interviewed: 1 },
    { jobId: JOB_3, total: 1, byStage: { Applied: 1 }, lastAppliedAt: new Date('2026-08-05T00:00:00.000Z'), interviewed: 0 },
  ];

  function rankedCtx(extra = {}) {
    const { Job, calls } = fakeJob({ docs });
    const seen = { grouped: [] };
    const ctx = ctxFor(Job, {
      aggregateApplicationsByJob: async (filter, user) => {
        seen.grouped.push({ filter, user });
        return grouped;
      },
      hireFactsForJobs: async () => new Map(),
      ...extra,
    });
    return { ctx, calls, seen };
  }

  it('scopes jobs by visibility and counts applications in one grouped call under the viewer\'s scope', async () => {
    const { ctx, calls, seen } = rankedCtx();
    const out = await getJobStats.execute({ rankBy: 'applications' }, ctx);
    assert.ok(contains(calls.find[0], VIS));
    assert.ok(contains(calls.find[0], { status: 'Active' }));
    assert.deepEqual(calls.limit, [POOL_MAX]);
    assert.deepEqual(seen.grouped, [{ filter: { jobIds: [JOB_ID, JOB_2, JOB_3] }, user: USER }]);
    assert.deepEqual(out.jobs.map((j) => [j.title, j.applications]), [['Busy', 2], ['Stalled', 1], ['Empty', 0]]);
    assert.equal(out.total, 3);
    assert.equal(out.jobsMatchingFilters, 3);
    assert.equal(out.filtersApplied.status, 'Active');
    assert.match(out.countBasis, /one per person per job/);
  });

  it('zero_applications, no_interviews, no_recent_applications and close_candidates filter as named', async () => {
    const zero = await getJobStats.execute({ rankBy: 'zero_applications' }, rankedCtx().ctx);
    assert.deepEqual(zero.jobs.map((j) => j.title), ['Empty']);

    const noInt = await getJobStats.execute({ rankBy: 'no_interviews' }, rankedCtx().ctx);
    assert.deepEqual(noInt.jobs.map((j) => j.title), ['Stalled']);
    assert.match(noInt.interviewedBasis, /scheduled or held interview/);

    const stale = await getJobStats.execute({ rankBy: 'no_recent_applications', noApplicationsInDays: 14 }, rankedCtx().ctx);
    assert.deepEqual(stale.jobs.map((j) => j.title).sort(), ['Empty', 'Stalled']);
    assert.equal(stale.noApplicationsInDays, 14);

    const close = await getJobStats.execute({ rankBy: 'close_candidates' }, rankedCtx().ctx);
    assert.deepEqual(close.jobs.map((j) => j.title), ['Stalled']);
    assert.match(close.jobs[0].closeSuggestion, /deadline has passed/);
    assert.match(close.suggestion, /Suggestions only/);
  });

  it('no_interviews: an applicant interviewed then rejected keeps the job off the list', async () => {
    const out = await getJobStats.execute({ rankBy: 'no_interviews' }, rankedCtx({
      aggregateApplicationsByJob: async () => [
        { jobId: JOB_3, total: 1, byStage: { Rejected: 1 }, lastAppliedAt: new Date('2026-08-05T00:00:00.000Z'), interviewed: 1 },
      ],
    }).ctx);
    assert.deepEqual(out.jobs, []);
  });

  it('oldest_open sorts the pool oldest first', async () => {
    const { ctx, calls } = rankedCtx();
    const out = await getJobStats.execute({ rankBy: 'oldest_open' }, ctx);
    assert.deepEqual(calls.sort, [{ createdAt: 1 }]);
    assert.deepEqual(out.jobs.map((j) => j.title), ['Empty', 'Stalled', 'Busy']);
  });

  it('an empty application scope leaves every job at zero', async () => {
    const out = await getJobStats.execute({ rankBy: 'applications' }, rankedCtx({ aggregateApplicationsByJob: async () => [] }).ctx);
    assert.ok(out.jobs.every((j) => j.applications === 0 && j.interviewed === 0));
  });

  it('no job pool means no application or hire read', async () => {
    const { Job } = fakeJob({ docs: [] });
    const out = await getJobStats.execute({ rankBy: 'applications' }, ctxFor(Job, {
      aggregateApplicationsByJob: () => assert.fail('no jobs, no application read'),
      hireFactsForJobs: () => assert.fail('no jobs, no hire read'),
    }));
    assert.equal(out.total, 0);
  });

  it('ranks past the old 300-job cap: every matching job is counted in one grouped call', async () => {
    const many = Array.from({ length: 450 }, (_, i) => ({
      _id: `64b7f0c2a1b2c3d4e5f6${String(i).padStart(4, '0')}`, title: `Job ${i}`, status: 'Active',
      createdAt: new Date('2026-09-01T00:00:00.000Z'), vacancies: 1,
    }));
    const { Job } = fakeJob({ docs: many });
    let groupedCalls = 0;
    const out = await getJobStats.execute({ rankBy: 'zero_applications' }, ctxFor(Job, {
      aggregateApplicationsByJob: async (filter) => { groupedCalls += 1; assert.equal(filter.jobIds.length, 450); return []; },
      hireFactsForJobs: async () => new Map(),
    }));
    assert.equal(groupedCalls, 1);
    assert.equal(out.total, 450);
    assert.equal(out.jobsConsidered, 450);
    assert.equal('poolNote' in out, false);
    assert.ok(POOL_MAX >= 5000);
  });

  it('clamps limit at 50 and renders a table', async () => {
    const out = await getJobStats.execute({ rankBy: 'applications', limit: 500 }, rankedCtx().ctx);
    assert.equal(out.jobs.length, 3);
    const r = getJobStats.render(out);
    assert.equal(r.blocks[0].type, 'table');
    assert.equal(r.blocks[0].rows[0].interviewed, '1');
    assert.equal(getJobStats.render({ notFound: true }), null);
  });
});

describe('jobStats helpers', () => {
  it('recentCutoff is IST midnight of today − (N − 1)', () => {
    assert.equal(recentCutoff(14, NOW).toISOString(), '2026-09-16T18:30:00.000Z'); // 2026-09-17 00:00 IST
    assert.equal(recentCutoff(1, NOW).toISOString(), '2026-09-29T18:30:00.000Z');
  });

  it('daysBetween counts IST calendar days, not 24-hour blocks', () => {
    // 23:00 IST on the 28th → 01:00 IST on the 29th is one calendar day
    assert.equal(daysBetween(new Date('2026-09-28T17:30:00.000Z'), new Date('2026-09-28T19:30:00.000Z')), 1);
    assert.equal(daysBetween(new Date('2026-09-28T19:30:00.000Z'), new Date('2026-09-28T20:30:00.000Z')), 0);
    assert.equal(daysBetween(null, NOW), null);
  });

  it('vacancyFacts: filled job gets time-to-fill; unfilled does not', () => {
    const job = { createdAt: new Date('2026-09-01T00:00:00.000Z'), vacancies: 2 };
    assert.equal(vacancyFacts(job, { hired: 1, lastHiredAt: new Date('2026-09-10T00:00:00.000Z') }).timeToFillDays, null);
    assert.equal(vacancyFacts(job, { hired: 1 }).vacanciesLeft, 1);
  });

  it('hireFactsForJobs dates a hire by its accepted offer, falling back to the application update', async () => {
    const pipelines = [];
    const JobApplication = {
      find: (q) => ({ cast: () => ({ casted: q }) }),
      aggregate: async (p) => {
        pipelines.push(p);
        return [{ _id: JOB_ID, hired: 2, lastHiredAt: new Date('2026-09-10T00:00:00.000Z'), hiredFromOffers: 1 }];
      },
    };
    const Offer = { collection: { collectionName: 'offers' } };
    const out = await hireFactsForJobs([JOB_ID], { JobApplication, Offer });
    assert.deepEqual(out.get(JOB_ID), { hired: 2, lastHiredAt: new Date('2026-09-10T00:00:00.000Z'), hiredFromOffers: 1 });
    const [match, lookup, , group] = pipelines[0];
    assert.deepEqual(match.$match, { casted: { job: { $in: [JOB_ID] }, status: 'Hired' } });
    assert.equal(lookup.$lookup.from, 'offers');
    assert.equal(lookup.$lookup.pipeline[0].$match.status, 'Accepted');
    assert.deepEqual(group.$group.lastHiredAt, { $max: { $ifNull: ['$_acceptedAt', '$updatedAt'] } });
    assert.equal((await hireFactsForJobs([], { JobApplication, Offer })).size, 0);
  });
});
