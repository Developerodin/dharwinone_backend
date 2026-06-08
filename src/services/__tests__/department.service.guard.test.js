import test from 'node:test';
import assert from 'node:assert/strict';
import { canDeactivateDepartment } from '../department.service.js';

test('canDeactivateDepartment blocks when OrgUnit references it', () => {
  const r = canDeactivateDepartment({ referencingUnits: 1, assignedEmployees: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reassign/i);
});
test('canDeactivateDepartment blocks when employees are assigned', () => {
  const r = canDeactivateDepartment({ referencingUnits: 0, assignedEmployees: 3 });
  assert.equal(r.ok, false);
});
test('canDeactivateDepartment allows when empty', () => {
  assert.deepEqual(canDeactivateDepartment({ referencingUnits: 0, assignedEmployees: 0 }), { ok: true });
});
