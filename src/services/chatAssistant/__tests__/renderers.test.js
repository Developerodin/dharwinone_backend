// Tests for renderer registry + per-kind renderers + fallback wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksFromFacts, renderBlock } from '../renderers/index.js';
import { renderEmployees } from '../renderers/employees.js';
import { renderAttendance } from '../renderers/attendance.js';
import { renderGenericCount } from '../renderers/genericCount.js';
import { renderPeople } from '../renderers/people.js';

// ── employees ──────────────────────────────────────────────────────────

test('renderEmployees produces TableBlock with status tone + markdown twin', () => {
  const data = {
    requestedRole: 'Agent',
    total: 2,
    records: [
      { name: 'Alice', employeeId: 'DBS01', employmentState: 'Active',   department: 'Sales', roleNames: ['Agent'] },
      { name: 'Bob',   employeeId: 'DBS02', employmentState: 'Resigned', department: 'Sales', roleNames: ['Agent'] },
    ],
  };
  const out = renderEmployees(data);
  assert.notEqual(out, null);
  assert.equal(out.block.type, 'table');
  assert.equal(out.block.id, 'employees');
  assert.equal(out.block.tableType, 'agents');
  assert.match(out.block.title, /Agents \(2\)/);
  assert.equal(out.block.rows.length, 2);
  assert.equal(out.block.rows[0].status.tone, 'success');
  assert.equal(out.block.rows[1].status.tone, 'neutral');
  // Agent profile defaults: Name + Role + Status (email pruned — empty in test rows).
  const colKeys = out.block.columns.map((c) => c.key);
  assert.deepEqual(colKeys, ['name', 'role', 'status']);
  assert.match(out.markdown, /\| Name \| Role \| Status \|/);
  assert.match(out.markdown, /Alice/);
});

test('renderEmployees Agent query never reveals employeeId, even to viewerRole=employee', () => {
  // Agent profile excludes employeeId by default — RBAC alone cannot opt
  // a column into a profile that does not list it. Guard against drift.
  const data = {
    requestedRole: 'Agent',
    total: 1,
    records: [{ name: 'Alice', employeeId: 'DBS01', employmentState: 'Active', roleNames: ['Agent'] }],
  };
  const out = renderEmployees(data, { viewerRole: 'employee' });
  const colKeys = out.block.columns.map((c) => c.key);
  assert.equal(colKeys.includes('employeeId'), false);
});

test('renderEmployees Employee query exposes employeeId to every viewer (record-side gate)', () => {
  const data = {
    requestedRole: 'Employee',
    total: 1,
    records: [{ name: 'Alice', employeeId: 'DBS01', employmentState: 'Active', roleNames: ['Employee'] }],
  };
  const asAdmin    = renderEmployees(data, { viewerRole: 'admin' });
  const asEmployee = renderEmployees(data, { viewerRole: 'employee' });
  assert.equal(asAdmin.block.columns.some((c) => c.key === 'employeeId'),    true);
  assert.equal(asEmployee.block.columns.some((c) => c.key === 'employeeId'), true);
  assert.equal(asAdmin.block.rows[0].employeeId,    'DBS01');
  assert.equal(asEmployee.block.rows[0].employeeId, 'DBS01');
});

test('renderEmployees blanks employeeId per-row when record role is not Employee', () => {
  const data = {
    requestedRole: 'Employee',
    total: 2,
    records: [
      { name: 'Alice', employeeId: 'DBS01', employmentState: 'Active', roleNames: ['Employee'] },
      { name: 'Bob',   employeeId: 'ADM01', employmentState: 'Active', roleNames: ['Administrator'] },
    ],
  };
  const out = renderEmployees(data, { viewerRole: 'admin' });
  assert.equal(out.block.rows[0].employeeId, 'DBS01');
  assert.equal(out.block.rows[1].employeeId, '—');
});

test('renderEmployees opts in role/dept only when query explicitly asks', () => {
  const data = {
    requestedRole: 'Employee',
    total: 1,
    records: [{ name: 'Alice', employeeId: 'DBS01', employmentState: 'Active', roleNames: ['Employee'], department: 'Eng' }],
  };
  const noAsk  = renderEmployees(data, { viewerRole: 'admin' });
  const askDpt = renderEmployees(data, { viewerRole: 'admin', queryArg: 'list employees with their department' });
  const askRol = renderEmployees(data, { viewerRole: 'admin', queryArg: 'list employees with their role' });
  assert.equal(noAsk.block.columns.some((c)  => c.key === 'department'), false);
  assert.equal(askDpt.block.columns.some((c) => c.key === 'department'), true);
  assert.equal(askRol.block.columns.some((c) => c.key === 'role'),       true);
});

test('renderEmployees returns null on notFound / null / empty records', () => {
  assert.equal(renderEmployees({ notFound: true }), null);
  assert.equal(renderEmployees(null), null);
  assert.equal(renderEmployees({ records: [] }), null);
});

// ── attendance ─────────────────────────────────────────────────────────

test('renderAttendance single-day → GroupBlock with KV + BadgeRow', () => {
  const data = {
    total: 50,
    perDay: [{
      date: '2026-05-07',
      counts: { Present: 40, Absent: 5, Leave: 3, Holiday: 0, WeekOff: 2, Incomplete: 0 },
    }],
  };
  const out = renderAttendance(data);
  assert.notEqual(out, null);
  assert.equal(out.block.type, 'group');
  const [kv, badges] = out.block.blocks;
  assert.equal(kv.type, 'kv');
  assert.equal(badges.type, 'badge_row');
  const presentChip = badges.chips.find((c) => c.label === 'Present');
  assert.equal(presentChip.count, 40);
  assert.equal(presentChip.tone, 'success');
  assert.match(out.markdown, /2026-05-07/);
  assert.match(out.markdown, /Present:\*\* 40/);
});

test('renderAttendance range → TableBlock with date column', () => {
  const data = {
    total: 50,
    perDay: [
      { date: '2026-05-06', counts: { Present: 39, Absent: 6, Leave: 3, Holiday: 0, WeekOff: 2, Incomplete: 0 } },
      { date: '2026-05-07', counts: { Present: 40, Absent: 5, Leave: 3, Holiday: 0, WeekOff: 2, Incomplete: 0 } },
    ],
  };
  const out = renderAttendance(data);
  assert.equal(out.block.type, 'table');
  assert.equal(out.block.id, 'attendance');
  assert.equal(out.block.rows.length, 2);
  assert.equal(out.block.columns[0].key, 'date');
});

test('renderAttendance returns null on notFound + needsTimeWindow + empty', () => {
  assert.equal(renderAttendance({ notFound: true }), null);
  assert.equal(renderAttendance({ needsTimeWindow: true }), null);
  assert.equal(renderAttendance({ perDay: [] }), null);
});

// ── genericCount ───────────────────────────────────────────────────────

test('renderGenericCount produces GroupBlock with KV + BadgeRow', () => {
  const fact = {
    kind: 'fetch_jobs',
    label: 'jobs',
    total: 12,
    breakdown: { open: 8, closed: 4 },
  };
  const out = renderGenericCount(fact);
  assert.equal(out.block.type, 'group');
  const [kv, badges] = out.block.blocks;
  assert.equal(kv.pairs[0].value, '12');
  assert.equal(badges.chips.length, 2);
  assert.match(out.markdown, /\*\*12 jobs\*\*/);
});

test('renderGenericCount with statusFilter surfaces filter pair', () => {
  const fact = {
    kind: 'fetch_leave_requests',
    label: 'leave requests',
    total: 5,
    statusFilter: 'pending',
  };
  const out = renderGenericCount(fact);
  const pairs = out.block.blocks[0].pairs;
  assert.equal(pairs.find((p) => p.label === 'Status filter').value, 'pending');
  assert.match(out.markdown, /status=pending/);
});

test('renderGenericCount returns null when total missing', () => {
  assert.equal(renderGenericCount({ kind: 'x', label: 'y' }), null);
  assert.equal(renderGenericCount(null), null);
});

// ── people ─────────────────────────────────────────────────────────────

test('renderPeople populated → TableBlock with profile-driven columns', () => {
  const data = {
    role: 'Agent',
    page: { from: 1, to: 1, total: 1, hasMore: false },
    records: [{ name: 'Alice', employeeId: 'DBS01', role: ['Agent'], department: 'Sales', employmentState: 'Active' }],
  };
  const out = renderPeople(data);
  assert.equal(out.block.type, 'table');
  assert.equal(out.block.tableType, 'agents');
  // Agent profile = Name + Role + Status (email pruned — empty in test rows).
  assert.deepEqual(out.block.columns.map((c) => c.key), ['name', 'role', 'status']);
  assert.match(out.markdown, /\| Name \| Role \| Status \|/);
});

test('renderPeople notFound → block null + legacy notFound markdown', () => {
  const out = renderPeople({
    notFound: true,
    role: 'Agent',
    searchedFor: 'Bob',
    page: { from: 0, to: 0, total: 0, hasMore: false },
    records: [],
  });
  assert.equal(out.block, null);
  assert.match(out.markdown, /No Agent matching 'Bob'/);
});

// ── renderBlock dispatcher ─────────────────────────────────────────────

test('renderBlock returns null for unknown kind', () => {
  assert.equal(renderBlock('fetch_widgets', { kind: 'fetch_widgets', total: 1 }, {}), null);
});

test('renderBlock dispatches employees fact-kind', () => {
  const out = renderBlock(
    'fetch_employees',
    { kind: 'fetch_employees', label: 'agents', total: 1, role: 'Agent' },
    {
      fetch_employees: {
        requestedRole: 'Agent',
        total: 1,
        records: [{ name: 'A', employeeId: 'DBS01', employmentState: 'Active', roleNames: ['Agent'] }],
      },
    },
  );
  assert.equal(out.block.type, 'table');
});

// ── blocksFromFacts integration ────────────────────────────────────────

test('blocksFromFacts dispatches primary fact first', () => {
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 4 },
    counts: [
      { kind: 'fetch_jobs', label: 'jobs', total: 4 },
      { kind: 'fetch_candidates', label: 'candidates', total: 9 },
    ],
  };
  const { blocks, markdownParts } = blocksFromFacts(facts, {}, {});
  assert.equal(blocks.length, 2);
  assert.match(markdownParts[0], /4 jobs/);
});

test('blocksFromFacts dedupes by source key (attendance day + range share source)', () => {
  const facts = {
    primary: { kind: 'attendance_summary_day', total: 50 },
    counts: [
      { kind: 'attendance_summary_day', total: 50 },
      { kind: 'attendance_summary_range', total: 50 },
    ],
  };
  const fetched = {
    fetch_attendance_summary: {
      total: 50,
      perDay: [{ date: '2026-05-07', counts: { Present: 40, Absent: 5, Leave: 3, Holiday: 0, WeekOff: 2, Incomplete: 0 } }],
    },
  };
  const { blocks } = blocksFromFacts(facts, fetched, {});
  assert.equal(blocks.length, 1);
});

test('blocksFromFacts emits FallbackBlock for empty/notFound payloads', () => {
  const facts = {
    primary: { kind: 'fetch_employees', label: 'employees', total: 0, role: 'Agent' },
    counts: [{ kind: 'fetch_employees', label: 'employees', total: 0, role: 'Agent' }],
  };
  const fetched = { fetch_employees: { notFound: true, searchedFor: 'Akash' } };
  const { blocks, markdownParts } = blocksFromFacts(facts, fetched, { queryArg: 'Akash' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'fallback');
  assert.equal(blocks[0].kind, 'employees');
  assert.match(blocks[0].title, /Akash/);
  assert.match(markdownParts[0], /Try next/);
});

test('blocksFromFacts surfaces fact.role filter in fallback when empty', () => {
  const facts = {
    primary: { kind: 'fetch_employees', label: 'agents', total: 0, role: 'Agent' },
    counts: [{ kind: 'fetch_employees', label: 'agents', total: 0, role: 'Agent' }],
  };
  const fetched = { fetch_employees: { notFound: true, searchedFor: null } };
  const { blocks } = blocksFromFacts(facts, fetched, {});
  assert.equal(blocks[0].type, 'fallback');
  assert.match(blocks[0].reasons.join(' '), /role=Agent/);
});

test('blocksFromFacts returns empty arrays for null facts', () => {
  const out = blocksFromFacts(null, {}, {});
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.markdownParts, []);
});

// ── list-intent suppression ────────────────────────────────────────────

test('blocksFromFacts suppresses count-only kinds on list intent', () => {
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 45 },
    counts: [{ kind: 'fetch_jobs', label: 'jobs', total: 45 }],
  };
  const out = blocksFromFacts(facts, {}, { queryArg: 'list all jobs' });
  assert.equal(out.blocks.length, 0);
});

test('blocksFromFacts still emits count card without list intent', () => {
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 45 },
    counts: [{ kind: 'fetch_jobs', label: 'jobs', total: 45 }],
  };
  const out = blocksFromFacts(facts, {}, { queryArg: 'how many jobs do we have' });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].type, 'group');
});

test('blocksFromFacts list intent on candidates with no records suppresses card', () => {
  const facts = {
    primary: { kind: 'fetch_candidates', label: 'candidates', total: 3 },
    counts: [{ kind: 'fetch_candidates', label: 'candidates', total: 3 }],
  };
  const out = blocksFromFacts(
    facts,
    { fetch_candidates: { records: [], total: 3 } },
    { queryArg: 'show all candidates' }
  );
  assert.equal(out.blocks.length, 0);
});

test('blocksFromFacts list intent on jobs with records emits TableBlock for pagination', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    title: `Job ${i + 1}`,
    jobType: 'Full-time',
    location: 'Bangalore',
    status: 'Active',
    experienceLevel: 'Mid',
    salaryRange: { min: 10, max: 20, currency: '₹' },
    organisation: { name: 'Acme' },
    jobOrigin: 'internal',
  }));
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 12 },
    counts: [{ kind: 'fetch_jobs', label: 'jobs', total: 12 }],
  };
  const fetched = { fetch_jobs: { records, counts: { internal: 12, external: 0, total: 12 }, label: 'job' } };
  const out = blocksFromFacts(facts, fetched, { queryArg: 'list all jobs' });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].type, 'table');
  assert.equal(out.blocks[0].rows.length, 12);
  assert.ok(out.blocks[0].columns.length > 0);
});

test('blocksFromFacts no-list-intent jobs without records still emits count card', () => {
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 45 },
    counts: [{ kind: 'fetch_jobs', label: 'jobs', total: 45 }],
  };
  const out = blocksFromFacts(facts, { fetch_jobs: { records: [], counts: { total: 45 } } }, { queryArg: 'how many jobs' });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].type, 'group');
});

test('blocksFromFacts list intent on jobs without records suppresses card', () => {
  const facts = {
    primary: { kind: 'fetch_jobs', label: 'jobs', total: 3 },
    counts: [{ kind: 'fetch_jobs', label: 'jobs', total: 3 }],
  };
  const out = blocksFromFacts(facts, { fetch_jobs: { records: [], counts: { total: 3 } } }, { queryArg: 'list all jobs' });
  assert.equal(out.blocks.length, 0);
});

test('blocksFromFacts list intent on candidates with records still emits table', () => {
  const facts = {
    primary: { kind: 'fetch_candidates', label: 'candidates', total: 1 },
    counts: [{ kind: 'fetch_candidates', label: 'candidates', total: 1 }],
  };
  const fetched = {
    fetch_candidates: {
      records: [
        { name: 'A', email: 'a@x.com', phoneNumber: '1', status: 'active', roleNames: ['Candidate'] },
      ],
      total: 1,
    },
  };
  const out = blocksFromFacts(facts, fetched, { queryArg: 'list all candidates' });
  assert.ok(out.blocks.length >= 1);
  assert.equal(out.blocks[0].type, 'table');
});
