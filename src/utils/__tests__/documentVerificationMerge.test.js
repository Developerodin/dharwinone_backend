import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocumentsPreserveKeys } from '../documentVerificationMerge.js';

const approved = {
  label: 'Passport',
  key: 'docs/old-passport.pdf',
  url: 'https://s3.example/old-passport.pdf',
  status: 1,
  verifiedAt: new Date('2025-01-01'),
  verifiedBy: 'admin-id',
};

test('new document by label gets pending status', () => {
  const merged = mergeDocumentsPreserveKeys([], [{ label: 'Resume', key: 'docs/resume.pdf' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 0);
  assert.equal(merged[0].verifiedAt, undefined);
});

test('unchanged S3 key preserves approval', () => {
  const merged = mergeDocumentsPreserveKeys([approved], [{ label: 'Passport', url: approved.url }]);
  assert.equal(merged[0].status, 1);
  assert.equal(merged[0].key, approved.key);
  assert.equal(merged[0].verifiedBy, 'admin-id');
});

test('replacement file with new S3 key resets to pending', () => {
  const merged = mergeDocumentsPreserveKeys([approved], [
    { label: 'Passport', key: 'docs/new-passport.pdf', url: 'https://s3.example/new.pdf' },
  ]);
  assert.equal(merged[0].status, 0);
  assert.equal(merged[0].key, 'docs/new-passport.pdf');
  assert.equal(merged[0].verifiedAt, undefined);
  assert.equal(merged[0].verifiedBy, undefined);
});
