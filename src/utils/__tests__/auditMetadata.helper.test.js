import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateAuditMetadata, idStr } from '../auditMetadata.helper.js';

test('buildUpdateAuditMetadata returns null on no-op update', () => {
  const before = { parentId: 'p1', headEmployeeId: 'h1' };
  const after = { parentId: 'p1', headEmployeeId: 'h1' };
  const body = { parentId: 'p1' };
  const meta = buildUpdateAuditMetadata(before, after, body, ['parentId', 'headEmployeeId'], ['parentId', 'headEmployeeId']);
  assert.equal(meta, null);
});

test('buildUpdateAuditMetadata captures id before/after on change', () => {
  const before = { parentId: 'p1' };
  const after = { parentId: 'p2' };
  const body = { parentId: 'p2' };
  const meta = buildUpdateAuditMetadata(before, after, body, ['parentId'], ['parentId']);
  assert.deepEqual(meta, {
    fieldsUpdated: ['parentId'],
    parentIdBefore: 'p1',
    parentIdAfter: 'p2',
  });
});

test('idStr normalizes empty to null', () => {
  assert.equal(idStr(null), null);
  assert.equal(idStr(''), null);
  assert.equal(idStr('abc'), 'abc');
});
