import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countApplications from '../countApplications.tool.js';
import listApplications from '../listApplications.tool.js';
import { applicationAge, statusAgeCutoff } from '../aging.js';

const VIEWER = { id: 'v1', _id: 'v1' };

function ctxWith(searchApplications, extra = {}) {
  return {
    user: VIEWER,
    requestId: 'r',
    deps: {
      searchApplications,
      resolveJobVisibilityFilter: async () => ({}),
      Job: {},
      ...extra,
    },
  };
}

describe('count_applications', () => {
  it('passes the applicant name and the viewer to searchApplications and returns no rows', async () => {
    let seen;
    const out = await countApplications.execute(
      { filters: { applicantName: 'Ranveer Singh' } },
      ctxWith(async (args) => { seen = args; return { total: 3, baseTotal: 3, breakdown: { Applied: 3 }, records: [{}] }; }),
    );
    assert.equal(seen.q, 'Ranveer Singh');
    assert.equal(seen.user, VIEWER);
    assert.equal(seen.requireApplicantQ, true);
    assert.equal(out.total, 3);
    assert.equal('records' in out, false);
  });

  it('reports an unknown applicant as notFound, not a silent 0 (Review Focus 4)', async () => {
    const out = await countApplications.execute(
      { filters: { applicantName: 'Nobody' } },
      ctxWith(async () => ({ total: 0, records: [], notFound: true })),
    );
    assert.equal(out.notFound, 'applicant');
  });
});

describe('list_applications', () => {
  const U = '64b7f0c2a1b2c3d4e5f60001';
  const lean = (rows) => ({ select: () => ({ lean: async () => rows }) });
  const people = (profiles, ownerEmail) => ({
    Employee: { find: () => lean(profiles) },
    User: { find: () => lean([{ _id: U, email: ownerEmail }]) },
  });

  it('maps rows to applicant / job / status only; a user id searches their own profiles exactly', async () => {
    let seen;
    const out = await listApplications.execute(
      { filters: { applicantUserId: U } },
      ctxWith(async (args) => {
        seen = args;
        return {
          total: 1,
          records: [{ _id: 'a1', status: 'Applied', job: { title: 'React Dev' }, candidate: { fullName: 'Ranveer Singh', email: 'x@y' } }],
        };
      }, people([{ _id: 'e1', owner: U, email: 'x@y' }], 'x@y')),
    );
    assert.deepEqual(seen.candidateIds, ['e1']);
    assert.equal(seen.userId, null, 'no name search behind the id');
    assert.deepEqual(out.records[0], {
      id: 'a1', applicant: 'Ranveer Singh', job: 'React Dev', status: 'Applied', appliedAt: null,
      daysInStatus: null, statusSince: null, statusChangedAt: null, stageDateBasis: 'none',
      daysToScreening: null, daysScreeningToInterview: null, screening: 'unknown',
    });
  });

  it('a recruiter’s user id does not pick up the candidate profiles they merely own', async () => {
    let called = false;
    const out = await listApplications.execute(
      { filters: { applicantUserId: U } },
      ctxWith(async () => { called = true; return { total: 0, records: [] }; }, people([
        { _id: 'e1', owner: U, email: 'cand1@x.com' }, { _id: 'e2', owner: U, email: 'cand2@x.com' },
      ], 'rec@x.com')),
    );
    assert.equal(out.notFound, 'applicant');
    assert.equal(called, false);
  });
});

const NOW = new Date('2026-09-15T08:00:00.000Z'); // 2026-09-15 13:30 IST

function historyApp(extra) {
  return {
    _id: 'a1',
    status: 'Screening',
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    updatedAt: new Date('2020-01-02T00:00:00.000Z'),
    job: { title: 'React Dev' },
    candidate: { fullName: 'Ranveer Singh' },
    ...extra,
  };
}

describe('applicationAge', () => {
  it('uses the last statusHistory entry and never createdAt or updatedAt', () => {
    const none = applicationAge(historyApp({ statusHistory: [] }), NOW);
    assert.equal(none.daysInStatus, null);
    assert.equal(none.statusSince, null);
    assert.equal(none.statusChangedAt, null);
    assert.equal(none.stageDateBasis, 'none');
    assert.equal(none.daysToScreening, null);
    assert.equal(none.screening, 'unknown');

    const last = new Date('2026-09-01T08:00:00.000Z');
    const aged = applicationAge(historyApp({
      statusChangedAt: new Date('2020-06-01T00:00:00.000Z'),
      statusHistory: [
        { from: null, to: 'Applied', at: new Date('2026-08-01T08:00:00.000Z') },
        { from: 'Applied', to: 'Screening', at: last },
      ],
    }), NOW);
    assert.equal(aged.daysInStatus, 14);
    assert.equal(aged.statusSince, last.toISOString());
    assert.equal(aged.stageDateBasis, 'history');
    assert.equal(aged.daysToScreening, 31);
    assert.equal(aged.daysScreeningToInterview, null);
    assert.equal(aged.screening, 'screened_never_interviewed');
  });

  it('counts IST calendar days, not UTC dates', () => {
    const now = new Date('2026-09-14T19:00:00.000Z'); // 2026-09-15 00:30 IST
    const at = new Date('2026-09-14T18:00:00.000Z'); // 2026-09-14 23:30 IST
    const age = applicationAge({ statusHistory: [{ from: null, to: 'Screening', at }] }, now);
    assert.equal(age.daysInStatus, 1);
    // Still inside the IST day one day ago, so this is not "more than 1 day".
    const cutoff = new Date(statusAgeCutoff(now, 1));
    assert.ok(at >= cutoff);
    assert.equal(age.daysInStatus > 1, false);
  });

  it('a partial history still ages from the last entry, but does not time Applied to Screening', () => {
    const age = applicationAge(historyApp({
      statusHistory: [{ from: 'Applied', to: 'Screening', at: new Date('2026-09-01T08:00:00.000Z') }],
    }), NOW);
    assert.equal(age.daysInStatus, 14);
    assert.equal(age.stageDateBasis, 'partial');
    assert.equal(age.daysToScreening, null);
    assert.equal(age.screening, 'screened_never_interviewed');
  });

  it('Interview in history is not "never interviewed"; no history is unknown, not not-screened', () => {
    const interviewed = applicationAge(historyApp({
      status: 'Interview',
      statusHistory: [
        { from: null, to: 'Applied', at: new Date('2026-08-01T08:00:00.000Z') },
        { from: 'Applied', to: 'Screening', at: new Date('2026-08-10T08:00:00.000Z') },
        { from: 'Screening', to: 'Interview', at: new Date('2026-09-01T08:00:00.000Z') },
      ],
    }), NOW);
    assert.equal(interviewed.screening, 'screened_interviewed');
    assert.equal(interviewed.daysScreeningToInterview, 22);

    const blank = applicationAge(historyApp({ status: 'Interview', statusHistory: [] }), NOW);
    assert.equal(blank.screening, 'unknown');
    assert.notEqual(blank.screening, 'not_screened');
  });
});

describe('application aging filters', () => {
  const screened = historyApp({
    _id: 'screened',
    statusHistory: [
      { from: null, to: 'Applied', at: new Date('2026-08-01T08:00:00.000Z') },
      { from: 'Applied', to: 'Screening', at: new Date('2026-09-01T08:00:00.000Z') },
    ],
  });
  const interviewed = historyApp({
    _id: 'interviewed',
    status: 'Interview',
    candidate: { fullName: 'Out of the screened set' },
    statusHistory: [
      { from: null, to: 'Screening', at: new Date('2026-08-01T08:00:00.000Z') },
      { from: 'Screening', to: 'Interview', at: new Date('2026-08-20T08:00:00.000Z') },
    ],
  });
  const unknown = historyApp({
    _id: 'unknown',
    candidate: { fullName: 'No History' },
    statusHistory: [],
  });
  const recent = historyApp({
    _id: 'recent',
    candidate: { fullName: 'Recent' },
    statusHistory: [
      { from: null, to: 'Applied', at: new Date('2026-09-10T08:00:00.000Z') },
      { from: 'Applied', to: 'Screening', at: new Date('2026-09-14T08:00:00.000Z') },
    ],
  });

  function agingCtx(records) {
    return ctxWith(async () => ({ total: records.length, records }), { now: () => NOW });
  }

  it('inStatusOverDays keeps only history older than N IST days and counts the rest as unknown', async () => {
    const out = await countApplications.execute(
      { filters: { inStatusOverDays: 7 } },
      agingCtx([screened, recent, unknown]),
    );
    assert.equal(out.total, 1);
    assert.equal(out.statusAgeUnknown, 1);
    assert.equal('records' in out, false);
    assert.equal(out.breakdown.Screening, 1);
  });

  it('exactly N days is not "more than N"', async () => {
    const exactly = historyApp({
      statusHistory: [{ from: null, to: 'Screening', at: new Date('2026-09-08T08:00:00.000Z') }],
    });
    const age = applicationAge(exactly, NOW);
    assert.equal(age.daysInStatus, 7);
    const out = await listApplications.execute(
      { filters: { inStatusOverDays: 7 }, limit: 20 },
      agingCtx([exactly]),
    );
    assert.equal(out.total, 0);
    assert.equal(out.records.length, 0);
    assert.equal(out.statusAgeUnknown, 0);
  });

  it('screened but never interviewed excludes interviewed rows and does not count missing history as screened or not screened', async () => {
    const out = await listApplications.execute(
      { filters: { screenedNeverInterviewed: true }, limit: 20 },
      agingCtx([screened, interviewed, unknown, recent]),
    );
    assert.equal(out.total, 2);
    assert.equal(out.screeningUnknown, 1);
    assert.deepEqual(out.records.map((r) => r.id).sort(), ['recent', 'screened']);
    assert.ok(out.records.every((r) => r.screening === 'screened_never_interviewed'));
    assert.equal(out.records.some((r) => r.applicant === 'No History'), false);
    assert.equal(out.records.some((r) => r.applicant === 'Out of the screened set'), false);
  });

  it('a 403 from the applications search is access denied and returns no rows', async () => {
    const err = new Error('nope');
    err.statusCode = 403;
    const out = await listApplications.execute(
      { filters: { applicantName: 'Priya' } },
      ctxWith(async () => { throw err; }),
    );
    assert.equal(out.error, 'You do not have access to job applications.');
    assert.deepEqual(out.records, []);
  });

  it('an out-of-scope application the search does not return is not in the result', async () => {
    const out = await listApplications.execute(
      { filters: { screenedNeverInterviewed: true }, limit: 20 },
      agingCtx([screened]),
    );
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].applicant, 'Ranveer Singh');
  });
});
