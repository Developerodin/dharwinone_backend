import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderJobRanking } from '../jobRanking.js';

const rankedJob = (overrides = {}) => ({
  _id: 'job1',
  rank: 1,
  title: 'Backend Engineer',
  jobType: 'Full-time',
  location: 'Remote',
  experienceLevel: 'Mid Level',
  status: 'Active',
  salaryRange: { min: 50000, max: 80000, currency: 'USD' },
  organisation: { name: 'Acme' },
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  jobOrigin: 'internal',
  _origin: 'Internal',
  ...overrides,
});

describe('renderJobRanking — single job (MAX/MIN/RANK)', () => {
  const plan = { operation: 'MAX', limit: 1, direction: 'desc', filters: {} };

  it('appends the job page link to the reply, not just the block (issue 1)', () => {
    const { markdown } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    assert.match(markdown, /\[Open job page\]\(http:\/\/localhost:3001\/ats\/jobs\?view=job1\)/);
  });

  it('shows Posted in the kv block (issue 2, where the underlying query already selects createdAt)', () => {
    const { block } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    assert.equal(block.pairs.find((p) => p.k === 'Posted').v, '2026-09-01T00:00:00.000Z');
  });

  it('shows Status as "—" instead of guessing "Active" (issue 5)', () => {
    const { block } = renderJobRanking(plan, { jobs: [rankedJob({ status: undefined })], total: 10 });
    const statusPair = block.pairs.find((p) => p.k === 'Status');
    assert.ok(statusPair, 'Status pair must still be present even when unknown');
    assert.equal(statusPair.v, '—');
  });
});

describe('renderJobRanking — ranked list', () => {
  const plan = { direction: 'desc', filters: {} };

  it('shows Status as "—" per row instead of guessing "Active" (issue 5)', () => {
    const jobs = [rankedJob({ _id: 'a', status: undefined }), rankedJob({ _id: 'b', rank: 2 })];
    const { block } = renderJobRanking(plan, { jobs, total: 2 });
    assert.equal(block.rows[0].status.v, '—');
  });
});
