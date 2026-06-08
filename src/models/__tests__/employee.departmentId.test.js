import test from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../employee.model.js';

test('Employee has a departmentId ObjectId path referencing Department', () => {
  const path = Employee.schema.path('departmentId');
  assert.ok(path, 'departmentId path should exist');
  assert.equal(path.instance, 'ObjectId');
  assert.equal(path.options.ref, 'Department');
});
test('Employee still has the legacy department string', () => {
  assert.equal(Employee.schema.path('department').instance, 'String');
});
test('Employee declares a departmentId index', () => {
  const hasIdx = Employee.schema.indexes().some(([def]) => def.departmentId === 1);
  assert.equal(hasIdx, true);
});
