import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneMissingIds } from '../workforceReconciliation.js';

test('pruneMissingIds keeps only ids present in the existing set', () => {
  assert.deepEqual(pruneMissingIds(['a', 'b', 'c'], ['a', 'c']).map(String), ['a', 'c']);
});
test('pruneMissingIds returns [] when nothing exists', () => {
  assert.deepEqual(pruneMissingIds(['a', 'b'], []), []);
});
