// Tests for the central chatbot column-visibility module.
//
// resolveViewerRole branches that hit MongoDB are exercised in integration
// tests; here we cover the deterministic branches (null user, no roleIds,
// platformSuperUser short-circuit) plus the synchronous helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWER_ROLES,
  COLUMN_VISIBILITY_RULES,
  TABLE_PROFILES,
  resolveViewerRole,
  canRenderEmployeeId,
  isColumnAllowedForRole,
  profileForRole,
  queryRequestsRole,
  queryRequestsDept,
  queryRequestsEmail,
  pruneEmptyColumns,
  applyColumnVisibility,
} from '../columnVisibility.js';

// ── canRenderEmployeeId — legacy predicate, now record-side gated ──────

test('canRenderEmployeeId is open for every viewer tier (record-side gate)', () => {
  for (const tier of [
    VIEWER_ROLES.EMPLOYEE, VIEWER_ROLES.ADMIN, VIEWER_ROLES.AGENT,
    VIEWER_ROLES.HR, VIEWER_ROLES.RECRUITER, VIEWER_ROLES.CANDIDATE,
    VIEWER_ROLES.STUDENT, VIEWER_ROLES.OTHER, undefined,
  ]) {
    assert.equal(canRenderEmployeeId(tier), true, `tier=${tier}`);
  }
});

test('COLUMN_VISIBILITY_RULES is empty (record-side gate replaces viewer ACL)', () => {
  assert.equal(COLUMN_VISIBILITY_RULES.employeeId, undefined);
});

// ── resolveViewerRole deterministic branches ───────────────────────────

test('resolveViewerRole — null user → other', async () => {
  assert.equal(await resolveViewerRole(null),      VIEWER_ROLES.OTHER);
  assert.equal(await resolveViewerRole(undefined), VIEWER_ROLES.OTHER);
});

test('resolveViewerRole — platformSuperUser short-circuits to admin', async () => {
  assert.equal(await resolveViewerRole({ platformSuperUser: true }), VIEWER_ROLES.ADMIN);
});

test('resolveViewerRole — empty roleIds → other', async () => {
  assert.equal(await resolveViewerRole({ roleIds: [] }), VIEWER_ROLES.OTHER);
});

// ── isColumnAllowedForRole ─────────────────────────────────────────────

test('isColumnAllowedForRole — unrestricted columns pass for any tier', () => {
  assert.equal(isColumnAllowedForRole({ key: 'name'   }, VIEWER_ROLES.OTHER), true);
  assert.equal(isColumnAllowedForRole({ key: 'status' }, VIEWER_ROLES.AGENT), true);
});

test('isColumnAllowedForRole — employeeId is unrestricted (record-side gate)', () => {
  for (const tier of [VIEWER_ROLES.ADMIN, VIEWER_ROLES.AGENT, VIEWER_ROLES.HR,
                      VIEWER_ROLES.RECRUITER, VIEWER_ROLES.CANDIDATE,
                      VIEWER_ROLES.STUDENT, VIEWER_ROLES.OTHER,
                      VIEWER_ROLES.EMPLOYEE]) {
    assert.equal(isColumnAllowedForRole({ key: 'employeeId' }, tier), true, `tier=${tier}`);
  }
});

// ── profileForRole ─────────────────────────────────────────────────────

test('profileForRole maps queried role → default column whitelist', () => {
  assert.deepEqual(profileForRole('Agent').defaultColumns,     ['name', 'email', 'role', 'status']);
  assert.deepEqual(profileForRole('agents').defaultColumns,    ['name', 'email', 'role', 'status']);
  assert.deepEqual(profileForRole('Recruiter').defaultColumns, ['name', 'email', 'role', 'status']);
  assert.deepEqual(profileForRole('Candidate').defaultColumns, ['name', 'appliedRole', 'email', 'status']);
  assert.deepEqual(
    profileForRole('Employee').defaultColumns,
    ['name', 'email', 'role', 'employeeId', 'joinDate', 'resignDate', 'status'],
  );
  assert.deepEqual(profileForRole('').defaultColumns,          TABLE_PROFILES.people.defaultColumns);
  assert.deepEqual(profileForRole(null).defaultColumns,        TABLE_PROFILES.people.defaultColumns);
});

// ── query-intent detectors ─────────────────────────────────────────────

test('queryRequestsRole / Dept / Email detect explicit asks', () => {
  assert.equal(queryRequestsRole('list employees'),                    false);
  assert.equal(queryRequestsRole('list employees with their role'),    true);
  assert.equal(queryRequestsDept('show staff'),                        false);
  assert.equal(queryRequestsDept('show staff with department'),        true);
  assert.equal(queryRequestsEmail('show staff with email'),            true);
  assert.equal(queryRequestsEmail(''),                                  false);
});

// ── pruneEmptyColumns ──────────────────────────────────────────────────

test('pruneEmptyColumns drops columns >70% empty (default threshold)', () => {
  const cols = [
    { key: 'name',  label: 'Name'  },
    { key: 'sparse', label: 'Sparse' },
    { key: 'full',  label: 'Full'  },
  ];
  const rows = [
    { name: 'A', sparse: '—', full: '1' },
    { name: 'B', sparse: '—', full: '2' },
    { name: 'C', sparse: '—', full: '3' },
    { name: 'D', sparse: 'x', full: '4' },
  ]; // sparse: 75% empty → drop.
  const out = pruneEmptyColumns(cols, rows);
  assert.deepEqual(out.map((c) => c.key), ['name', 'full']);
});

test('pruneEmptyColumns is a no-op on empty rows', () => {
  const cols = [{ key: 'a', label: 'A' }];
  assert.deepEqual(pruneEmptyColumns(cols, []), cols);
});

// ── applyColumnVisibility — orchestrator ───────────────────────────────

test('applyColumnVisibility keeps employeeId for every viewer when rows carry it', () => {
  const candidates = [
    { key: 'name',       label: 'Name'  },
    { key: 'employeeId', label: 'Employee ID' },
    { key: 'status',     label: 'Status', format: 'badge' },
  ];
  const rows = [{ name: 'Alice', employeeId: 'DBS01', status: { v: 'Active', tone: 'success' } }];

  for (const tier of [VIEWER_ROLES.ADMIN, VIEWER_ROLES.EMPLOYEE, VIEWER_ROLES.AGENT]) {
    const out = applyColumnVisibility({
      candidateColumns: candidates,
      rows,
      viewerRole: tier,
      profile: TABLE_PROFILES.employees,
    });
    assert.equal(out.columns.some((c) => c.key === 'employeeId'), true, `tier=${tier}`);
    assert.equal(out.rows[0].employeeId, 'DBS01', `tier=${tier}`);
  }
});

test('applyColumnVisibility honours queryArg opt-in for role/dept', () => {
  const candidates = [
    { key: 'name',       label: 'Name' },
    { key: 'role',       label: 'Role' },
    { key: 'department', label: 'Dept' },
    { key: 'status',     label: 'Status', format: 'badge' },
  ];
  const rows = [{ name: 'Alice', role: 'Eng', department: 'Platform', status: { v: 'Active', tone: 'success' } }];

  const noAsk = applyColumnVisibility({
    candidateColumns: candidates,
    rows,
    viewerRole: VIEWER_ROLES.ADMIN,
    profile: TABLE_PROFILES.employees,
  });
  assert.equal(noAsk.columns.some((c) => c.key === 'role'),       false);
  assert.equal(noAsk.columns.some((c) => c.key === 'department'), false);

  const askDept = applyColumnVisibility({
    candidateColumns: candidates,
    rows,
    viewerRole: VIEWER_ROLES.ADMIN,
    profile: TABLE_PROFILES.employees,
    queryArg: 'list employees with their dept',
  });
  assert.equal(askDept.columns.some((c) => c.key === 'department'), true);
});

test('applyColumnVisibility forceInclude bypasses profile gate (no RBAC)', () => {
  const candidates = [
    { key: 'name',       label: 'Name' },
    { key: 'employeeId', label: 'Employee ID' },
  ];
  const rows = [{ name: 'Alice', employeeId: 'DBS01' }];

  const out = applyColumnVisibility({
    candidateColumns: candidates,
    rows,
    viewerRole: VIEWER_ROLES.ADMIN,
    profile: TABLE_PROFILES.agents,        // profile excludes employeeId
    forceInclude: ['employeeId'],          // caller insists
  });
  assert.equal(out.columns.some((c) => c.key === 'employeeId'), true);
  assert.equal(out.rows[0].employeeId, 'DBS01');
});
