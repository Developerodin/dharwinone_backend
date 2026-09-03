import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpdateAuditMetadata,
  describeCompensationChange,
  buildFieldChangeLog,
  idStr,
} from '../auditMetadata.helper.js';

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

test('buildFieldChangeLog records the old and new value of every field that moved', () => {
  const changes = buildFieldChangeLog(
    { fullName: 'Old Name', designation: 'Intern', salaryRange: '0' },
    { fullName: 'New Name', designation: 'Intern', salaryRange: '50000' },
    { fullName: 'New Name', designation: 'Intern', salaryRange: '50000' }
  );
  assert.deepEqual(changes, {
    fullName: { from: 'Old Name', to: 'New Name' },
    salaryRange: { from: '0', to: '50000' },
  });
});

test('buildFieldChangeLog ignores fields the payload never carried', () => {
  // The record may differ for reasons this request had nothing to do with.
  const changes = buildFieldChangeLog(
    { fullName: 'Old', employeeId: 'DBS100' },
    { fullName: 'New', employeeId: 'DBS200' },
    { fullName: 'New' }
  );
  assert.deepEqual(changes, { fullName: { from: 'Old', to: 'New' } });
});

test('buildFieldChangeLog returns null when nothing actually moved', () => {
  // A bulk form save that changed nothing should leave no change record at all.
  assert.equal(buildFieldChangeLog({ fullName: 'Same' }, { fullName: 'Same' }, { fullName: 'Same' }), null);
});

test('buildFieldChangeLog omits bulky fields rather than inlining blobs', () => {
  // documents/salarySlips/profilePicture carry base64 and signed URLs. Recording that they
  // changed is useful; pasting them into every audit row is not.
  const changes = buildFieldChangeLog(
    { documents: [{ url: 'a' }], profilePicture: { url: 'x' }, fullName: 'Old' },
    { documents: [{ url: 'b' }, { url: 'c' }], profilePicture: { url: 'y' }, fullName: 'New' },
    { documents: [], profilePicture: {}, fullName: 'New' }
  );
  assert.deepEqual(changes.fullName, { from: 'Old', to: 'New' });
  assert.equal(changes.documents, '[changed]');
  assert.equal(changes.profilePicture, '[changed]');
});

test('buildFieldChangeLog never records a password, changed or not', () => {
  const changes = buildFieldChangeLog(
    { password: 'old-secret', fullName: 'Old' },
    { password: 'new-secret', fullName: 'New' },
    { password: 'new-secret', fullName: 'New' }
  );
  assert.equal('password' in changes, false);
});

test('buildFieldChangeLog compares ids by value, not by reference', () => {
  // ObjectId instances are never === each other, which would report false changes on every save.
  const changes = buildFieldChangeLog(
    { position: { toString: () => 'abc123' } },
    { position: { toString: () => 'abc123' } },
    { position: 'abc123' }
  );
  assert.equal(changes, null);
});

test('describeCompensationChange treats a missing document as absent rather than throwing', () => {
  assert.equal(describeCompensationChange(null, null), null);
  assert.deepEqual(
    describeCompensationChange(null, { compensationType: 'paid', compensationSource: 'manual' }),
    { before: null, after: 'paid', sourceBefore: null, sourceAfter: 'manual' }
  );
});
