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

  it('emits pairs in the {label, value} wire shape the frontend KV.tsx reads (issue C1)', () => {
    // KVBlock on the wire is { label: string; value: string; tone?: Tone }
    // (chatResponse.ts, KV.tsx renders p.label/p.value) — {k,v} rendered a
    // blank card since the frontend never finds label/value on the pair.
    const { block } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    for (const p of block.pairs) {
      assert.ok('label' in p, `pair missing "label": ${JSON.stringify(p)}`);
      assert.ok('value' in p, `pair missing "value": ${JSON.stringify(p)}`);
      assert.equal(typeof p.value, 'string');
      assert.ok(!('k' in p) && !('v' in p), `pair still has legacy k/v: ${JSON.stringify(p)}`);
    }
  });

  it('appends the job page link to the reply, not just the block (issue 1)', () => {
    const { markdown } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    assert.match(markdown, /\[Open job page\]\(http:\/\/localhost:3001\/ats\/jobs\?view=job1\)/);
  });

  it('shows Posted in the kv block (issue 2, where the underlying query already selects createdAt)', () => {
    const { block } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    assert.equal(block.pairs.find((p) => p.label === 'Posted').value, '2026-09-01T00:00:00.000Z');
  });

  it('shows Status as "—" instead of guessing "Active" (issue 5)', () => {
    const { block } = renderJobRanking(plan, { jobs: [rankedJob({ status: undefined })], total: 10 });
    const statusPair = block.pairs.find((p) => p.label === 'Status');
    assert.ok(statusPair, 'Status pair must still be present even when unknown');
    assert.equal(statusPair.value, '—');
  });

  it('formats the salary with currency + en dash instead of raw "USD50000-80000" (issue C2)', () => {
    const { block, markdown } = renderJobRanking(plan, { jobs: [rankedJob()], total: 10 });
    assert.equal(block.pairs.find((p) => p.label === 'Salary').value, '$50,000 – $80,000');
    assert.match(markdown, /\$50,000 – \$80,000/);
    assert.doesNotMatch(markdown, /USD50000/);
  });
});

describe('renderJobRanking — ranked list', () => {
  const plan = { direction: 'desc', filters: {} };

  it('shows Status as "—" per row instead of guessing "Active" (issue 5)', () => {
    const jobs = [rankedJob({ _id: 'a', status: undefined }), rankedJob({ _id: 'b', rank: 2 })];
    const { block } = renderJobRanking(plan, { jobs, total: 2 });
    assert.equal(block.rows[0].status.v, '—');
  });

  it('formats the salary column instead of raw "USD50000-80000" (issue C2), ignoring a stale salaryLabel', () => {
    // salaryLabel would be set upstream (runJobEntityQuery.js, out of scope
    // here) by jobRank.js's own unformatted formatJobSalary — the row must
    // recompute from salaryRange rather than trust it.
    const jobs = [rankedJob({ _id: 'a', salaryLabel: 'USD50000–80000' })];
    const { block } = renderJobRanking(plan, { jobs, total: 1 });
    assert.equal(block.rows[0].salary, '$50,000 – $80,000');
  });
});
