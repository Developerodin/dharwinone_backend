import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNewFilters } from '../referralLeadsQueryBuilder.js';
import { quickFilterEffectiveStatusMatch, QUICK_APPLIED_EFFECTIVE_STATUSES } from '../referralLeads.service.js';

test('appliedOnly quick filter uses effectiveStatus applied only', () => {
  const match = applyNewFilters({ appliedOnly: true });
  assert.equal(match.referralPipelineStatus, undefined);
  const stages = quickFilterEffectiveStatusMatch({ appliedOnly: true });
  assert.deepEqual(stages[0].$match.effectiveStatus.$in, QUICK_APPLIED_EFFECTIVE_STATUSES);
});

test('applyNewFilters supports convertedEmployees filter', () => {
  const match = applyNewFilters({ convertedEmployees: true });
  // Conversion is historical — resigned employees stay in the converted set.
  assert.equal(match.isActive, undefined);
  assert.ok(match.joiningDate.$lte instanceof Date);
});
