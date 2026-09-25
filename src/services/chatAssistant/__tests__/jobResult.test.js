import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapJobRow, buildJobPageUrl } from '../jobResult.js';

describe('buildJobPageUrl', () => {
  it('builds a deep link into the recruiter-facing jobs list preview panel', () => {
    // /ats/jobs?view=<id> is the real frontend route — it opens JobPreviewPanel
    // via the "Deep-link" effect in ats/jobs/page.tsx. There is no dedicated
    // single-job "view" page to link to instead.
    assert.equal(buildJobPageUrl('abc123'), 'http://localhost:3001/ats/jobs?view=abc123');
  });

  it('returns null without an id', () => {
    assert.equal(buildJobPageUrl(null), null);
    assert.equal(buildJobPageUrl(''), null);
  });

  it('encodes the id', () => {
    assert.equal(buildJobPageUrl('a b'), 'http://localhost:3001/ats/jobs?view=a%20b');
  });
});

describe('mapJobRow', () => {
  const baseRow = {
    _id: 'job1',
    title: 'Backend Engineer',
    jobType: 'Full-time',
    location: 'Remote',
    status: 'Active',
    experienceLevel: 'Mid Level',
    minExperience: 3,
    maxExperience: 5,
    salaryRange: { min: 50000, max: 80000, currency: 'USD' },
    organisation: { name: 'Acme' },
    skillTags: ['Node'],
    skillRequirements: [
      { name: 'Node', level: 'Advanced', required: true },
      { name: 'GraphQL', required: false },
    ],
    vacancies: 2,
    applicationDeadline: new Date('2026-10-15T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    jobOrigin: 'internal',
    externalPlatformUrl: null,
    externalRef: { source: 'linkedin', externalId: 'ext-9' },
    jobDescription: 'Build things.',
    assignedRecruiter: { _id: 'rec1', name: 'Asha Rao' },
  };

  it('carries the job id and a job page link', () => {
    const out = mapJobRow(baseRow);
    assert.equal(out.jobId, 'job1');
    assert.equal(out.jobUrl, 'http://localhost:3001/ats/jobs?view=job1');
  });

  it('keeps vacancies, applicationDeadline and createdAt (issue 2)', () => {
    const out = mapJobRow(baseRow);
    assert.equal(out.vacancies, 2);
    assert.equal(out.applicationDeadline.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(out.createdAt.toISOString(), '2026-09-01T00:00:00.000Z');
  });

  it('keeps skillRequirements and externalRef instead of dropping them (issue 3)', () => {
    const out = mapJobRow(baseRow);
    assert.equal(out.skillRequirements.length, 2);
    assert.deepEqual(out.externalRef, { source: 'linkedin', externalId: 'ext-9' });
  });

  it('extracts the populated recruiter name', () => {
    const out = mapJobRow(baseRow);
    assert.equal(out.recruiterName, 'Asha Rao');
  });

  it('does not invent a recruiter name from an unpopulated ObjectId', () => {
    const out = mapJobRow({ ...baseRow, assignedRecruiter: 'raw-object-id-string' });
    assert.equal(out.recruiterName, null);
  });

  it('handles rows missing the newer optional fields (e.g. resolveJobByTitle.js selects a narrower set)', () => {
    const out = mapJobRow({
      _id: 'job2',
      title: 'Recruiter',
      status: 'Active',
      salaryRange: {},
      organisation: { name: 'Acme' },
    });
    assert.equal(out.vacancies, null);
    assert.equal(out.applicationDeadline, null);
    assert.equal(out.recruiterName, null);
    assert.deepEqual(out.skillRequirements, []);
  });
});
