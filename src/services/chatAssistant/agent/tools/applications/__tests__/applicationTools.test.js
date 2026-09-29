import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countApplications from '../countApplications.tool.js';
import listApplications from '../listApplications.tool.js';

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
  it('maps rows to applicant / job / status only', async () => {
    const out = await listApplications.execute(
      { filters: { applicantUserId: 'u1' } },
      ctxWith(async () => ({
        total: 1,
        records: [{ _id: 'a1', status: 'Applied', job: { title: 'React Dev' }, candidate: { fullName: 'Ranveer Singh', email: 'x@y' } }],
      })),
    );
    assert.deepEqual(out.records[0], { id: 'a1', applicant: 'Ranveer Singh', job: 'React Dev', status: 'Applied', appliedAt: null });
  });
});
