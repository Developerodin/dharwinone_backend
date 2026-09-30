import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getRecruitmentFunnel from '../getRecruitmentFunnel.tool.js';
import { previousWindow, dateApplication, computeFunnel } from '../funnel.js';

const NOW = new Date('2026-09-30T06:00:00.000Z');
const id = (n) => `64b7f0c2a1b2c3d4e5f6${String(n).padStart(4, '0')}`;
const d = (s) => new Date(`${s}T06:00:00.000Z`);
const userWith = (perms) => ({ id: id(1), name: 'Viewer', authContext: { permissions: new Set(perms) } });

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
    distinct: async (field, f) => { log.push({ model: name, method: 'distinct', field, filter: f }); return (await handler(f, 'distinct', field)) || []; },
  };
}

// Three applications created in September:
//  A1 has full status history (Applied → Screening → Interview → Offered → Hired), one approximate entry,
//     plus an accepted offer whose placement joined.
//  A2 has no history: derived dates from an interview meeting and a (still open) offer.
//  A3 has no history and no downstream records: basis none, Rejected.
const APPS = [
  {
    _id: id(101), job: id(900), candidate: id(201), status: 'Hired', createdAt: d('2026-09-01'),
    statusHistory: [
      { from: null, to: 'Applied', at: d('2026-09-01') },
      { from: 'Applied', to: 'Screening', at: d('2026-09-03') },
      { from: 'Screening', to: 'Interview', at: d('2026-09-05') },
      { from: 'Interview', to: 'Offered', at: d('2026-09-15') },
      { from: 'Offered', to: 'Hired', at: d('2026-09-17'), approximate: true },
    ],
  },
  { _id: id(102), job: id(900), candidate: id(202), status: 'Offered', createdAt: d('2026-09-02'), statusHistory: [] },
  { _id: id(103), job: id(901), candidate: id(203), status: 'Rejected', createdAt: d('2026-09-04') },
];

function ctxFor(perms, over = {}) {
  const log = [];
  const h = {
    JobApplication: () => APPS.map((a) => ({ ...a })),
    Meeting: (f) => (f.applicationId ? [{ applicationId: id(102), createdAt: d('2026-09-06') }] : [
      { jobId: id(900), recruiter: { id: id(7) } }, { jobId: id(901) },
    ]),
    Offer: (f) => (f.jobApplication ? [
      { _id: id(301), jobApplication: id(101), status: 'Accepted', createdAt: d('2026-09-15'), acceptedAt: d('2026-09-17') },
      { _id: id(302), jobApplication: id(102), status: 'Sent', createdAt: d('2026-09-20') },
    ] : [{ job: id(900) }]),
    Placement: () => [{ offer: id(301), status: 'Joined', enteredOnboardingAt: d('2026-09-21'), joinedAt: d('2026-09-25') }],
    Job: () => [{ _id: id(900), assignedRecruiter: id(7) }, { _id: id(901), createdBy: id(8) }],
    User: () => [{ _id: id(7), name: 'Rita Recruiter' }, { _id: id(8), name: 'Carl Creator' }],
    ...over.models,
  };
  const m = (name) => model(name, h[name] || (() => []), log);
  const seen = {};
  const deps = {
    now: () => NOW,
    isAdmin: async () => false,
    JobApplication: m('JobApplication'), Meeting: m('Meeting'), Offer: m('Offer'), Placement: m('Placement'),
    Job: m('Job'), User: m('User'), Employee: m('Employee'),
    buildApplicantQuery: async (filter) => { seen.filter = filter; return { query: {} }; },
    aggregateApplicationsByJob: async () => [
      { jobId: id(900), byStage: { Applied: 3, Offered: 1, Hired: 1 } },
      { jobId: id(901), byStage: { Screening: 2, Rejected: 4 } },
    ],
    meetingScope: async () => ({ filter: {} }),
    buildOfferVisibilityClause: async () => ({ unrestricted: true }),
    resolveJobVisibilityFilter: async () => ({}),
    ...over.deps,
  };
  return { ctx: { user: userWith(perms), deps }, log, seen };
}

const ALL = ['candidates.read', 'interviews.read', 'offers.read', 'jobs.read'];
const conv = (res, from, to) => res.funnel.conversions.find((c) => c.from === from && c.to === to);

describe('previousWindow', () => {
  it('a whole month compares with the previous calendar month', () => {
    assert.deepEqual(previousWindow({ from: '2026-09-01', to: '2026-09-30' }), { from: '2026-08-01', to: '2026-08-31' });
    assert.deepEqual(previousWindow({ from: '2026-03-01', to: '2026-03-31' }), { from: '2026-02-01', to: '2026-02-28' });
  });
  it('any other window compares with the equal-length period just before', () => {
    assert.deepEqual(previousWindow({ from: '2026-09-10', to: '2026-09-19' }), { from: '2026-08-31', to: '2026-09-09' });
  });
});

describe('dateApplication (uses applicationStatusHistory.stageEntryDates)', () => {
  it('history wins when the application has full history; derived dates are ignored', () => {
    const r = dateApplication({ ...APPS[0], _firstInterviewAt: d('2026-09-10') });
    assert.equal(r.entry.basis, 'history');
    assert.equal(r.entry.approximate, true);
    assert.equal(r.dates.interview.toISOString(), d('2026-09-05').toISOString());
    assert.equal(r.dates.screening.toISOString(), d('2026-09-03').toISOString());
  });
  it('no history → derived interview / offer dates; screening is not captured', () => {
    const r = dateApplication({ ...APPS[1], _firstInterviewAt: d('2026-09-06'), _firstOfferAt: d('2026-09-20'), _offer: { status: 'Sent' } });
    assert.equal(r.entry.basis, 'derived');
    assert.equal(r.dates.screening, null);
    assert.equal(r.level, 3);
    assert.equal(r.open, true);
  });
  it('no history and no records → basis none, only the application date', () => {
    const r = dateApplication(APPS[2]);
    assert.equal(r.entry.basis, 'none');
    assert.equal(r.level, 0);
    assert.equal(r.open, false);
  });
  it('an empty cohort gives zero denominators and null rates, never NaN', () => {
    const f = computeFunnel([], NOW);
    assert.equal(f.applications, 0);
    assert.ok(f.conversions.every((c) => c.denominator === 0 && c.rate === null));
    assert.equal(f.slowestStage, null);
  });
});

describe('get_recruitment_funnel', () => {
  it('happy path: conversions with numerator/denominator, basis, slowest stage, cycle time, workload', async () => {
    const c = ctxFor(ALL);
    const res = await getRecruitmentFunnel.execute({ window: { from: '2026-09-01', to: '2026-09-30' } }, c.ctx);
    const f = res.funnel;
    assert.equal(f.status, 'ok');
    assert.equal(f.applications, 3);
    assert.deepEqual(f.basis, { history: 1, derived: 1, none: 1, approximate: 1 });
    assert.equal(c.seen.filter.excludeInternal, true);
    assert.equal(c.seen.filter.dateFrom, '2026-08-31T18:30:00.000Z');

    assert.deepEqual(conv(res, 'application', 'interview'), { from: 'application', to: 'interview', numerator: 2, denominator: 3, rate: 66.7 });
    assert.deepEqual(conv(res, 'interview', 'offer'), { from: 'interview', to: 'offer', numerator: 2, denominator: 2, rate: 100 });
    assert.deepEqual(conv(res, 'offer', 'accepted'), { from: 'offer', to: 'accepted', numerator: 1, denominator: 2, rate: 50 });
    assert.equal(conv(res, 'onboarding', 'hired').rate, 100);
    const screening = f.stages.find((s) => s.stage === 'screening');
    assert.deepEqual(screening, { stage: 'screening', reached: 1, population: 'history', notCaptured: 2 });
    assert.equal(conv(res, 'application', 'screening').population, 'history');

    assert.equal(f.slowestStage.from, 'interview');
    assert.equal(f.slowestStage.to, 'offer');
    assert.equal(f.cycleTime.applicationToOnboarding.n, 1);
    assert.equal(f.cycleTime.applicationToOnboarding.avgDays, 20);
    assert.deepEqual(f.stageAging, [{ stage: 'offer', open: 1, avgDays: 10, maxDays: 10, withoutDate: 0 }]);
    assert.ok(res.notes.some((n) => /approximate/.test(n)));

    const w = res.recruiterWorkload;
    assert.equal(w.status, 'ok');
    assert.deepEqual(w.rows[0], { recruiter: 'Rita Recruiter', openApplications: 3, openInterviews: 1, openOffers: 1, total: 5 });
    assert.deepEqual(w.rows[1], { recruiter: 'Carl Creator', openApplications: 2, openInterviews: 1, openOffers: 0, total: 3 });
    assert.match(w.note, /not a measure of recruiter quality/);

    const r = getRecruitmentFunnel.render(res);
    assert.equal(r.blocks.length, 2);
    assert.equal(r.facts.counts[0].total, 3);
  });

  it('compareTo previous adds the previous month and per-rate change', async () => {
    const c = ctxFor(ALL);
    const res = await getRecruitmentFunnel.execute({ window: { from: '2026-09-01', to: '2026-09-30' }, compareTo: 'previous' }, c.ctx);
    assert.deepEqual(res.previous.window, { from: '2026-08-01', to: '2026-08-31' });
    assert.equal(res.previous.status, 'ok');
    assert.equal(res.change.length, res.funnel.conversions.length);
    assert.equal(res.change[0].delta, 0);
  });

  it('restricted: no Applications-page permission → the section is named, no numbers', async () => {
    const res = await getRecruitmentFunnel.execute({}, ctxFor(['evaluation.read']).ctx);
    assert.equal(res.status, 'restricted');
    assert.equal(res.section, 'Applications');
    assert.ok(!('funnel' in res));
  });

  it('workload sections the viewer lacks are restricted, reported as null, never filled', async () => {
    const res = await getRecruitmentFunnel.execute({ window: { from: '2026-09-01', to: '2026-09-30' } }, ctxFor(['candidates.read']).ctx);
    assert.deepEqual(res.recruiterWorkload.sections, { interviews: 'restricted', offers: 'ok' });
    assert.ok(res.recruiterWorkload.rows.every((r) => r.openInterviews === null));
  });

  it('a failing cohort read is an error section, the workload still answers', async () => {
    const c = ctxFor(ALL, { models: { JobApplication: () => { throw new Error('db down'); } } });
    const res = await getRecruitmentFunnel.execute({ window: { from: '2026-09-01', to: '2026-09-30' } }, c.ctx);
    assert.equal(res.funnel.status, 'error');
    assert.equal(res.funnel.error, 'db down');
    assert.equal(res.recruiterWorkload.status, 'ok');
    assert.equal(getRecruitmentFunnel.render(res), null);
  });

  it('recruiter narrows to their jobs (assigned, else created); unknown name → notFound', async () => {
    const c = ctxFor(ALL, {
      models: {
        Job: (f, method, field) => {
          if (method === 'distinct') return field === 'assignedRecruiter' ? [id(7)] : [id(8)];
          if (f.$and) return [{ _id: id(900) }];
          return [{ _id: id(900), assignedRecruiter: id(7) }];
        },
        User: (f) => (f.name ? [{ _id: id(7), name: 'Rita Recruiter' }] : [{ _id: id(7), name: 'Rita Recruiter' }]),
      },
    });
    const res = await getRecruitmentFunnel.execute({ window: { from: '2026-09-01', to: '2026-09-30' }, recruiter: 'rita' }, c.ctx);
    assert.equal(res.recruiter, 'Rita Recruiter');
    assert.deepEqual(c.seen.filter.jobIds, [id(900)]);

    const none = ctxFor(ALL, { models: { Job: (f, method) => (method === 'distinct' ? [id(7)] : []), User: () => [] } });
    const nf = await getRecruitmentFunnel.execute({ recruiter: 'nobody' }, none.ctx);
    assert.deepEqual(nf, { notFound: 'recruiter', searchedFor: 'nobody' });
  });

  it('a recruiter with no jobs gives an empty cohort without querying applications', async () => {
    const c = ctxFor(ALL, { models: { Job: (f, method) => (method === 'distinct' ? [id(7)] : []), User: () => [{ _id: id(7), name: 'Rita' }] } });
    const res = await getRecruitmentFunnel.execute({ recruiter: 'Rita' }, c.ctx);
    assert.equal(res.funnel.applications, 0);
    assert.ok(!c.log.some((l) => l.model === 'JobApplication'));
    assert.ok(res.notes.some((n) => /cohort is empty/.test(n)));
  });

  it('input schema: jobId must be an id, compareTo only "previous"', () => {
    assert.ok(getRecruitmentFunnel.input.validate({ jobId: 'abc' }).error);
    assert.ok(getRecruitmentFunnel.input.validate({ compareTo: 'last_year' }).error);
    assert.ok(!getRecruitmentFunnel.input.validate({ window: { from: '2026-09-01', to: '2026-09-30' }, compareTo: 'previous' }).error);
  });
});
