import test from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../employee.model.js';

test('Employee.compensationType defaults to paid', () => {
  assert.equal(new Employee().compensationType, 'paid');
});

test('Employee.compensationSource defaults to jobTypeDerived', () => {
  assert.equal(new Employee().compensationSource, 'jobTypeDerived');
});

test('Employee.compensationType enforces the enum', () => {
  const emp = new Employee({ compensationType: 'stipend' });
  const err = emp.validateSync();
  assert.ok(err?.errors?.compensationType, 'expected compensationType validation error');
});
