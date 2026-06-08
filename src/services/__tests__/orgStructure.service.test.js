import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReparentAllowed } from '../orgStructure.service.js';

test('assertReparentAllowed throws on a cycle', () => {
  const units = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }];
  assert.throws(() => assertReparentAllowed(units, 'a', 'b'), /loop|cycle/i);
});
test('assertReparentAllowed passes for a legal move', () => {
  const units = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }];
  assert.doesNotThrow(() => assertReparentAllowed(units, 'b', null));
});
