import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _planTeamMutations } from '../teamExcel.service.js';

test('plan: additive merge — skip member already on team', () => {
  const existingEmpIds = new Set(['o1']);
  const memberRows = [
    { matched: { _id: 'o1', name: 'A', isActive: true, email: 'a@x.com' }, teamSeniority: 'Lead' },
    { matched: { _id: 'o2', name: 'B', isActive: true, email: 'b@x.com' }, teamSeniority: 'Member' },
  ];
  const plan = _planTeamMutations(existingEmpIds, memberRows);
  assert.deepEqual(plan.toInsert.map((p) => String(p.employeeId)), ['o2']);
  assert.deepEqual(plan.duplicates.map((p) => String(p.employeeId)), ['o1']);
});

test('plan: unmatched + inactive rows skipped', () => {
  const memberRows = [
    { matched: null, skipReason: 'employee_not_found', employeeEmail: 'x@y.com' },
    { matched: { _id: 'o2', name: 'B', isActive: false, email: 'b@x.com' } },
  ];
  const plan = _planTeamMutations(new Set(), memberRows);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.skipped.length, 2);
});
