import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderJobs, renderJobResult } from '../jobs.js';

const job = (overrides = {}) => ({
  jobId: 'job1',
  jobUrl: 'http://localhost:3001/ats/jobs?view=job1',
  title: 'Backend Engineer',
  jobType: 'Full-time',
  location: 'Remote',
  experienceLevel: 'Mid Level',
  status: 'Active',
  salaryRange: { min: 50000, max: 80000, currency: 'USD' },
  organisation: { name: 'Acme' },
  skillTags: ['Node'],
  skillRequirements: [],
  vacancies: 3,
  applicationDeadline: new Date('2026-10-15T00:00:00.000Z'),
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  jobOrigin: 'internal',
  _origin: 'Internal',
  ...overrides,
});

describe('renderJobs — single job detail (kv block)', () => {
  it('emits pairs in the {label, value} wire shape the frontend KV.tsx reads (issue C1)', () => {
    // KVBlock on the wire is { label: string; value: string; tone?: Tone }
    // (chatResponse.ts, KV.tsx renders p.label/p.value) — {k,v} rendered a
    // blank card since the frontend never finds label/value on the pair.
    const { block } = renderJobs({ records: [job()] }, { listIntent: false }, null);
    for (const p of block.pairs) {
      assert.ok('label' in p, `pair missing "label": ${JSON.stringify(p)}`);
      assert.ok('value' in p, `pair missing "value": ${JSON.stringify(p)}`);
      assert.equal(typeof p.value, 'string');
      assert.ok(!('k' in p) && !('v' in p), `pair still has legacy k/v: ${JSON.stringify(p)}`);
    }
  });

  it('includes the job link in the markdown reply, not just the block (issue 1)', () => {
    const { block, markdown } = renderJobs({ records: [job()] }, { listIntent: false }, null);
    assert.match(markdown, /\[Open job page\]\(http:\/\/localhost:3001\/ats\/jobs\?view=job1\)/);
    const jobLinkPair = block.pairs.find((p) => p.label === 'Job link');
    assert.equal(jobLinkPair.value, 'http://localhost:3001/ats/jobs?view=job1');
  });

  it('shows Openings, Deadline and Posted (issue 2)', () => {
    const { block } = renderJobs({ records: [job()] }, { listIntent: false }, null);
    assert.equal(block.pairs.find((p) => p.label === 'Openings').value, '3');
    assert.equal(block.pairs.find((p) => p.label === 'Deadline').value, '2026-10-15T00:00:00.000Z');
    assert.equal(block.pairs.find((p) => p.label === 'Posted').value, '2026-09-01T00:00:00.000Z');
  });

  it('renders required/preferred skills separately (issue 3)', () => {
    const j = job({
      skillRequirements: [
        { name: 'Node', level: 'Advanced', required: true },
        { name: 'GraphQL', required: false },
      ],
    });
    const { block } = renderJobs({ records: [j] }, { listIntent: false }, null);
    assert.equal(block.pairs.find((p) => p.label === 'Required skills').value, 'Node (Advanced)');
    assert.equal(block.pairs.find((p) => p.label === 'Preferred skills').value, 'GraphQL');
  });

  it('shows Status as "—" instead of guessing "Active" (issue 5)', () => {
    const { block } = renderJobs({ records: [job({ status: undefined })] }, { listIntent: false }, null);
    const statusPair = block.pairs.find((p) => p.label === 'Status');
    assert.ok(statusPair, 'Status pair must still be present even when unknown');
    assert.equal(statusPair.value, '—');
  });

  it('formats the salary range with currency + en dash (issue 4)', () => {
    const { block } = renderJobs({ records: [job()] }, { listIntent: false }, null);
    assert.equal(block.pairs.find((p) => p.label === 'Salary').value, '$50,000 – $80,000');
  });
});

describe('renderJobs — list (table block)', () => {
  it('says "showing first N of M" when the list is capped (issue 6)', () => {
    const records = [job({ jobId: 'a', title: 'A' }), job({ jobId: 'b', title: 'B' })];
    const { block, markdown } = renderJobs(
      { records, counts: { total: 5 } },
      { listIntent: true },
      null,
    );
    assert.equal(block.title, 'Jobs — showing first 2 of 5');
    assert.match(markdown, /Showing 2 of 5/);
  });

  it('keeps the plain "(N)" title when nothing was capped', () => {
    const records = [job({ jobId: 'a', title: 'A' }), job({ jobId: 'b', title: 'B' })];
    const { block } = renderJobs({ records, counts: { total: 2 } }, { listIntent: true }, null);
    assert.equal(block.title, 'Jobs (2)');
  });

  it('shows Status as "—" per row instead of guessing "Active" (issue 5)', () => {
    // A single record always renders as the kv detail block (see renderJobs'
    // `wantDetail` rule), so this needs ≥2 records to reach the table path.
    const records = [job({ jobId: 'a', status: undefined }), job({ jobId: 'b' })];
    const { block } = renderJobs({ records, counts: { total: 2 } }, { listIntent: true }, null);
    assert.equal(block.rows[0].status.v, '—');
  });
});

describe('renderJobResult — atomic list envelope', () => {
  const payload = (rows, total) => ({
    result: { total, jobs: rows },
    query: { filters: {} },
    intent: 'list',
  });

  it('says "showing first N of M" when rows are capped (issue 6)', () => {
    const rows = [job({ jobId: 'a', title: 'A' }), job({ jobId: 'b', title: 'B' })];
    const { block, markdown } = renderJobResult(payload(rows, 237), { listIntent: true });
    assert.equal(block.title, 'Jobs — showing first 2 of 237');
    assert.match(markdown, /Showing 2 of 237/);
  });

  it('shows the full "(N)" title when all matches are in the table', () => {
    const rows = [job({ jobId: 'a' })];
    const { block } = renderJobResult(payload(rows, 1), { listIntent: true });
    assert.equal(block.title, 'Jobs (1)');
  });

  it('never falls back to "Active" for a missing status (issue 5)', () => {
    const rows = [job({ jobId: 'a', status: undefined })];
    const { block } = renderJobResult(payload(rows, 1), { listIntent: true });
    assert.equal(block.rows[0].status.v, '—');
  });
});
