import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIdList } from '../normalizeIdList.js';

const VALID = '507f1f77bcf86cd799439011';
const VALID2 = '507f191e810c19729de860ea';

test('accepts array of valid ids', () => {
  assert.deepEqual(normalizeIdList([VALID, VALID2]).map(String), [VALID, VALID2]);
});

test('accepts comma-separated string', () => {
  assert.deepEqual(normalizeIdList(`${VALID}, ${VALID2}`).map(String), [VALID, VALID2]);
});

test('drops invalid ids and dedupes', () => {
  assert.deepEqual(normalizeIdList([VALID, 'nope', VALID]).map(String), [VALID]);
});

test('empty / nullish returns empty array', () => {
  assert.deepEqual(normalizeIdList(null), []);
  assert.deepEqual(normalizeIdList(''), []);
  assert.deepEqual(normalizeIdList([]), []);
});
