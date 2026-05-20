import test from 'node:test';
import assert from 'node:assert/strict';
import { findMissingPositionIds } from '../teamGroup.service.js';

test('findMissingPositionIds returns [] when all ids are found', () => {
  assert.deepEqual(findMissingPositionIds(['a', 'b'], ['a', 'b']), []);
});
test('findMissingPositionIds returns the missing ids', () => {
  assert.deepEqual(findMissingPositionIds(['a', 'b', 'c'], ['a']), ['b', 'c']);
});
test('findMissingPositionIds handles empty requested list', () => {
  assert.deepEqual(findMissingPositionIds([], ['a']), []);
});
