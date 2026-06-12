import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNewFilters } from '../referralLeadsQueryBuilder.js';

test('applyNewFilters supports pendingReferrals filter', () => {
  const match = applyNewFilters({ pendingReferrals: true });
  assert.deepEqual(match.referralPipelineStatus.$in, [
    'pending',
    'profile_complete',
    'applied',
    'in_review',
  ]);
});

test('applyNewFilters supports convertedEmployees filter', () => {
  const match = applyNewFilters({ convertedEmployees: true });
  // Conversion is historical — resigned employees stay in the converted set.
  assert.equal(match.isActive, undefined);
  assert.ok(match.joiningDate.$lte instanceof Date);
});
