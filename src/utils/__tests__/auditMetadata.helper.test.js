import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateAuditMetadata, describeCompensationChange, idStr } from '../auditMetadata.helper.js';

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

test('describeCompensationChange reports nothing when value and provenance both hold', () => {
  const same = { compensationType: 'unpaid', compensationSource: 'jobTypeDerived' };
  assert.equal(describeCompensationChange(same, { ...same }), null);
});

test('describeCompensationChange reports a changed value', () => {
  assert.deepEqual(
    describeCompensationChange(
      { compensationType: 'unpaid', compensationSource: 'jobTypeDerived' },
      { compensationType: 'paid', compensationSource: 'manual' }
    ),
    { before: 'unpaid', after: 'paid', sourceBefore: 'jobTypeDerived', sourceAfter: 'manual' }
  );
});

test('describeCompensationChange reports provenance moving to manual even when the value holds', () => {
  // The case the old audit condition missed. Every accepted unpaid-internship hire in production
  // was restamped 'manual' with the value unchanged, and nothing was logged — which is why a real
  // revert had no trail to follow.
  assert.deepEqual(
    describeCompensationChange(
      { compensationType: 'unpaid', compensationSource: 'jobTypeDerived' },
      { compensationType: 'unpaid', compensationSource: 'manual' }
    ),
    { before: 'unpaid', after: 'unpaid', sourceBefore: 'jobTypeDerived', sourceAfter: 'manual' }
  );
});

test('describeCompensationChange treats a missing document as absent rather than throwing', () => {
  assert.equal(describeCompensationChange(null, null), null);
  assert.deepEqual(
    describeCompensationChange(null, { compensationType: 'paid', compensationSource: 'manual' }),
    { before: null, after: 'paid', sourceBefore: null, sourceAfter: 'manual' }
  );
});
