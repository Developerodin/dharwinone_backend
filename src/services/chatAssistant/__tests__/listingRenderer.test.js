import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderListing } from '../listingRenderer.js';

const sample = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Person ${i + 1}`,
    employeeId: `DBS${i + 1}`,
    role: ['Employee'],
    designation: 'Engineer',
    department: 'Tech',
    employmentState: 'active',
  }));

describe('renderListing', () => {
  it('renders a markdown table with header row + records', () => {
    const out = renderListing({
      records: sample(3),
      page: { from: 1, to: 3, total: 3, hasMore: false },
      role: 'Employee',
    });
    assert.match(out, /\| Name +\| EmpID +\| Role +\| Dept +\| Status +\|/);
    assert.match(out, /Person 1/);
    assert.match(out, /DBS3/);
  });

  it('emits "Showing N–M of T" footer when more pages remain', () => {
    const out = renderListing({
      records: sample(25),
      page: { from: 1, to: 25, total: 112, hasMore: true },
      role: 'Employee',
    });
    assert.match(out, /Showing 1–25 of 112/);
    assert.match(out, /Reply ['"']next['"'] for more/i);
  });

  it('emits "End of list" footer on last page', () => {
    const out = renderListing({
      records: sample(12),
      page: { from: 101, to: 112, total: 112, hasMore: false },
      role: 'Employee',
    });
    assert.match(out, /End of list — 112 total/);
  });

  it('emits notFound message when records empty + searchedFor present', () => {
    const out = renderListing({
      records: [],
      page: { from: 0, to: 0, total: 0, hasMore: false },
      role: 'Employee',
      notFound: true,
      searchedFor: 'Zaphod',
    });
    assert.match(out, /No Employee matching ['"']Zaphod['"']/i);
  });

  it('omits null fields gracefully (no "null" or "N/A" in output)', () => {
    const out = renderListing({
      records: [{ name: 'X', employeeId: 'DBS5', role: ['Employee'], designation: null, department: null, employmentState: 'active' }],
      page: { from: 1, to: 1, total: 1, hasMore: false },
      role: 'Employee',
    });
    assert.doesNotMatch(out, /\bnull\b/);
    assert.doesNotMatch(out, /\bN\/A\b/);
  });

  it('includes multi-role footer note when any record has >1 role', () => {
    const out = renderListing({
      records: [{ name: 'X', employeeId: 'DBS5', role: ['Employee', 'Agent'], designation: 'Eng', department: 'Tech', employmentState: 'active' }],
      page: { from: 1, to: 1, total: 1, hasMore: false },
      role: 'Employee',
    });
    assert.match(out, /Some people hold multiple roles/i);
  });
});
