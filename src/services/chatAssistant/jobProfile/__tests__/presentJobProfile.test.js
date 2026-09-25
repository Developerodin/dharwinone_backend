import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presentJobProfile } from '../presentJobProfile.js';

const resolvedUnique = (overrides = {}) => ({
  kind: 'unique',
  query: 'Backend Engineer',
  job: {
    jobId: 'job1',
    jobUrl: 'http://localhost:3001/ats/jobs?view=job1',
    title: 'Backend Engineer',
    organisation: { name: 'Acme' },
  },
  raw: {
    title: 'Backend Engineer',
    jobType: 'Full-time',
    location: 'Remote',
    experienceLevel: 'Mid Level',
    minExperience: 3,
    maxExperience: 5,
    salaryRange: { min: 50000, max: 80000, currency: 'USD' },
    organisation: { name: 'Acme' },
    skillTags: ['Node'],
    vacancies: 2,
    status: 'Active',
  },
  ...overrides,
});

describe('presentJobProfile — full profile', () => {
  it('prints the experience range once, not three times (issue 7)', async () => {
    // "full profile" doesn't match any single-fact/anything-else trigger, so
    // this exercises renderJobProfileSummary's depth === 'full' branch.
    const { reply } = await presentJobProfile({
      resolved: resolvedUnique(),
      userMessage: 'full profile',
      userId: null,
      adminId: null,
      depth: 'full',
    });
    const occurrences = reply.split('3–5 years').length - 1;
    assert.equal(occurrences, 1, `expected the combined experience range once, got ${occurrences} in: ${reply}`);
    assert.doesNotMatch(reply, /min experience/i);
    assert.doesNotMatch(reply, /max experience/i);
  });

  it('appends the job page link to the reply (issue 1)', async () => {
    const { reply } = await presentJobProfile({
      resolved: resolvedUnique(),
      userMessage: 'full profile',
      userId: null,
      adminId: null,
      depth: 'full',
    });
    assert.match(reply, /\[Open job page\]\(http:\/\/localhost:3001\/ats\/jobs\?view=job1\)/);
  });

  it('omits the link when the job has none', async () => {
    const resolved = resolvedUnique({ job: { jobId: 'job1', jobUrl: null, title: 'Backend Engineer' } });
    const { reply } = await presentJobProfile({
      resolved,
      userMessage: 'full profile',
      userId: null,
      adminId: null,
      depth: 'full',
    });
    assert.doesNotMatch(reply, /Open job page/);
  });
});
