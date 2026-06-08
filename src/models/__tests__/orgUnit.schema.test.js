import test from 'node:test';
import assert from 'node:assert/strict';
import OrgUnit from '../orgUnit.model.js';

test('OrgUnit requires name and type', () => {
  const u = new OrgUnit({});
  const err = u.validateSync();
  assert.ok(err?.errors?.name);
  assert.ok(err?.errors?.type);
});
test('OrgUnit rejects an invalid type', () => {
  const u = new OrgUnit({ name: 'X', type: 'bogus' });
  const err = u.validateSync();
  assert.ok(err?.errors?.type);
});
test('OrgUnit accepts the four valid types', () => {
  for (const type of ['ceo', 'manager', 'supervisor', 'department']) {
    const u = new OrgUnit({ name: 'N', type });
    assert.equal(u.validateSync()?.errors?.type, undefined, `${type} should be valid`);
  }
});
test('OrgUnit defaults parentId null, directToCeo false, order 0, isActive true', () => {
  const u = new OrgUnit({ name: 'CEO', type: 'ceo' });
  assert.equal(u.parentId, null);
  assert.equal(u.directToCeo, false);
  assert.equal(u.order, 0);
  assert.equal(u.isActive, true);
});
test('OrgUnit declares a parentId index', () => {
  const hasParent = OrgUnit.schema.indexes().some(([def]) => def.parentId === 1);
  assert.equal(hasParent, true);
});
