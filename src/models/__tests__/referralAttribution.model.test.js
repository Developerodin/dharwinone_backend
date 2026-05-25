import test from 'node:test';
import assert from 'node:assert/strict';
import ReferralAttribution from '../referralAttribution.model.js';

test('schema has required fields with correct types', () => {
  const paths = ReferralAttribution.schema.paths;
  assert.equal(paths.tenantId.instance, 'ObjectId');
  assert.equal(paths.subjectProfileId.instance, 'ObjectId');
  assert.equal(paths.jobId.instance, 'ObjectId');
  assert.equal(paths.salesAgentUserId.instance, 'ObjectId');
  assert.equal(paths.salesAgentSnapshot.schema.paths.name.instance, 'String');
  assert.equal(paths.lifecycleStageAtAssignment.instance, 'String');
  assert.equal(paths.isCurrent.instance, 'Boolean');
  assert.equal(paths.isRevoked.instance, 'Boolean');
  assert.equal(paths.source.instance, 'String');
});

test('source enum is correct', () => {
  const source = ReferralAttribution.schema.path('source');
  assert.deepEqual(
    source.enumValues.sort(),
    ['manual_assign', 'manual_change', 'manual_revoke'].sort()
  );
});

test('partial unique index exists on (tenant, candidate, job, isCurrent, isRevoked)', () => {
  const indexes = ReferralAttribution.schema.indexes();
  const partial = indexes.find(
    ([, opts]) => opts.unique && opts.partialFilterExpression?.isCurrent === true
  );
  assert.ok(partial, 'partial unique index missing');
  assert.equal(partial[1].partialFilterExpression.isRevoked, false);
});
