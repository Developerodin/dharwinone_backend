import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectKeyBase, formatTaskCode, isProjectKeyDuplicateError } from './pmTaskCode.js';

test('deriveProjectKeyBase uses initials for multi-word names', () => {
  assert.equal(deriveProjectKeyBase('Dharwin Business Solutions'), 'DBS');
});

test('deriveProjectKeyBase uses first 4 chars for single-word names', () => {
  assert.equal(deriveProjectKeyBase('Dharwin'), 'DHAR');
});

test('deriveProjectKeyBase strips punctuation and uppercases', () => {
  assert.equal(deriveProjectKeyBase('ai-native trainer!'), 'ANT');
});

test('deriveProjectKeyBase pads short results to 3 chars', () => {
  assert.equal(deriveProjectKeyBase('Hi'), 'HIX');
});

test('deriveProjectKeyBase falls back to PRJ for empty input', () => {
  assert.equal(deriveProjectKeyBase('   '), 'PRJ');
});

test('formatTaskCode zero-pads to 3 digits', () => {
  assert.equal(formatTaskCode('DBS', 1), 'DBS-001');
  assert.equal(formatTaskCode('DBS', 42), 'DBS-042');
});

test('formatTaskCode does not truncate large sequences', () => {
  assert.equal(formatTaskCode('DBS', 1234), 'DBS-1234');
});

test('isProjectKeyDuplicateError matches E11000 on the projectKey index', () => {
  assert.equal(isProjectKeyDuplicateError({ code: 11000, keyPattern: { projectKey: 1 } }), true);
});

test('isProjectKeyDuplicateError ignores E11000 on a different index', () => {
  assert.equal(isProjectKeyDuplicateError({ code: 11000, keyPattern: { email: 1 } }), false);
});

test('isProjectKeyDuplicateError ignores non-duplicate errors and nullish input', () => {
  assert.equal(isProjectKeyDuplicateError({ code: 121 }), false);
  assert.equal(isProjectKeyDuplicateError(null), false);
});
