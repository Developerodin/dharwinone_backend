import test from 'node:test';
import assert from 'node:assert/strict';
import { compensationTypeForJobType } from '../../constants/atsPipeline.js';

test('offer write derives compensationType from jobType', () => {
  assert.equal(compensationTypeForJobType('FT_40'), 'paid');
  assert.equal(compensationTypeForJobType('PT_25'), 'paid');
  assert.equal(compensationTypeForJobType('INTERN_UNPAID'), 'unpaid');
});
