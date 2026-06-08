import test from 'node:test';
import assert from 'node:assert/strict';
import Department from '../department.model.js';

test('Department requires a name', () => {
  const d = new Department({});
  const err = d.validateSync();
  assert.ok(err?.errors?.name, 'name should be required');
});
test('Department defaults isActive to true', () => {
  const d = new Department({ name: 'Engineering' });
  assert.equal(d.isActive, true);
});
test('Department trims name', () => {
  const d = new Department({ name: '  Sales  ' });
  assert.equal(d.name, 'Sales');
});
test('Department exposes isNameTaken static', () => {
  assert.equal(typeof Department.isNameTaken, 'function');
});
test('Department declares a name index', () => {
  const hasName = Department.schema.indexes().some(([def]) => def.name === 1);
  assert.equal(hasName, true);
});
