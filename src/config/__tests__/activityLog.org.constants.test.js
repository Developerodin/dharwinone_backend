import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityActions, EntityTypes } from '../activityLog.js';

test('organization ActivityActions constants exist', () => {
  assert.equal(ActivityActions.ORG_UNIT_CREATE, 'orgUnit.create');
  assert.equal(ActivityActions.ORG_UNIT_UPDATE, 'orgUnit.update');
  assert.equal(ActivityActions.ORG_UNIT_REPARENT, 'orgUnit.reparent');
  assert.equal(ActivityActions.ORG_UNIT_HEAD_ASSIGN, 'orgUnit.headAssign');
  assert.equal(ActivityActions.ORG_UNIT_HEAD_CLEAR, 'orgUnit.headClear');
  assert.equal(ActivityActions.ORG_UNIT_DEACTIVATE, 'orgUnit.deactivate');
  assert.equal(ActivityActions.ORG_UNIT_REACTIVATE, 'orgUnit.reactivate');
  assert.equal(ActivityActions.ORG_UNIT_DELETE, 'orgUnit.delete');
  assert.equal(ActivityActions.DEPARTMENT_CREATE, 'department.create');
  assert.equal(ActivityActions.DEPARTMENT_UPDATE, 'department.update');
  assert.equal(ActivityActions.ORG_STRUCTURE_EXPORT, 'orgStructure.export');
  assert.equal(ActivityActions.EMPLOYEE_DEPARTMENT_ASSIGN, 'employee.departmentAssign');
  assert.equal(ActivityActions.ORG_MUTATE_DENIED, 'org.mutate.denied');
});

test('organization EntityTypes constants exist', () => {
  assert.equal(EntityTypes.ORG_UNIT, 'OrgUnit');
  assert.equal(EntityTypes.DEPARTMENT, 'Department');
  assert.equal(EntityTypes.ORG_STRUCTURE, 'OrgStructure');
  assert.equal(EntityTypes.EMPLOYEE, 'Employee');
});
