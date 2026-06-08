import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDepartmentToEmployee } from '../employeeDepartment.helper.js';

test('applyDepartmentToEmployee writes BOTH departmentId and department name', () => {
  const emp = {};
  applyDepartmentToEmployee(emp, { _id: 'dept1', name: 'Engineering' });
  assert.equal(String(emp.departmentId), 'dept1');
  assert.equal(emp.department, 'Engineering');
});
test('applyDepartmentToEmployee clears both when department is null', () => {
  const emp = { departmentId: 'x', department: 'Old' };
  applyDepartmentToEmployee(emp, null);
  assert.equal(emp.departmentId, null);
  assert.equal(emp.department, '');
});
test('applyDepartmentToEmployee throws on a malformed department', () => {
  assert.throws(() => applyDepartmentToEmployee({}, { _id: 'd' }), /name/);
});
