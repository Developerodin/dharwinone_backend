import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateKeyError } from '../withAttributionTransaction.js';

test('isDuplicateKeyError detects E11000', () => {
  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 11001 }), false);
  assert.equal(isDuplicateKeyError(null), false);
});
