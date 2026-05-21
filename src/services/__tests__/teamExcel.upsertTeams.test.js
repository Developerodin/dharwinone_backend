import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _planTeamMutations } from '../teamExcel.service.js';

test('plan: additive merge — skip member already on team', () => {
  const existingEmpIds = new Set(['o1']);
  const memberRows = [
    { matched: { _id: 'o1', fullName: 'A', isActive: true, email: 'a@x.com' }, teamSeniority: 'Lead' },
    { matched: { _id: 'o2', fullName: 'B', isActive: true, email: 'b@x.com' }, teamSeniority: 'Member' },
  ];
  const plan = _planTeamMutations(existingEmpIds, memberRows);
  assert.deepEqual(plan.toInsert.map((p) => String(p.employeeId)), ['o2']);
  assert.deepEqual(plan.duplicates.map((p) => String(p.employeeId)), ['o1']);
});

test('plan: inactive row skipped; unmatched-but-no-name row skipped', () => {
  const memberRows = [
    // unmatched AND no name/email at all -> nothing to display -> plain skip
    { matched: null, skipReason: 'missing_identifiers' },
    { matched: { _id: 'o2', fullName: 'B', isActive: false, email: 'b@x.com' } },
  ];
  const plan = _planTeamMutations(new Set(), memberRows);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.equal((plan.orphans || []).length, 0);
});

test('plan: BUG 2(b) — unmatched row with a typed name becomes an orphan, not a silent skip', () => {
  const memberRows = [
    {
      matched: null,
      skipReason: 'employee_not_found',
      employeeName: 'Jane Unlinked',
      employeeEmail: 'jane@x.com',
      teamSeniority: 'Member',
    },
  ];
  const plan = _planTeamMutations(new Set(), memberRows);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.skipped.length, 0, 'must NOT be silently skipped');
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0].legacyName, 'Jane Unlinked');
  assert.equal(plan.orphans[0].legacyEmail, 'jane@x.com');
  assert.equal(plan.orphans[0].orphanReason, 'no_email_match');
  assert.equal(plan.orphans[0].seniority, 'Member');
});

test('plan: ambiguous name unmatched row becomes an ambiguous_match orphan', () => {
  const memberRows = [
    { matched: null, skipReason: 'ambiguous_employee_name', employeeName: 'John Doe' },
  ];
  const plan = _planTeamMutations(new Set(), memberRows);
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0].legacyName, 'John Doe');
  assert.equal(plan.orphans[0].orphanReason, 'ambiguous_match');
});
