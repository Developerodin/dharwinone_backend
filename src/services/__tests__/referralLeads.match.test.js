import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  buildReferralLeadsMatch,
  buildEffectiveStatusStages,
  effectiveStatusMatch,
} from '../referralLeads.service.js';

test('scoped view surfaces leads referred-by-me OR sales-agent-is-me', async () => {
  const user = { _id: new mongoose.Types.ObjectId() };
  const mongo = await buildReferralLeadsMatch({ user, canSeeAll: false, query: {} });

  // Base constraint: only actual referral leads are listed.
  assert.deepEqual(mongo.referredByUserId, { $exists: true, $ne: null });

  // Scoping is an $or over referrer and assigned sales agent.
  const orClause = (mongo.$and || []).find((c) => Array.isArray(c.$or));
  assert.ok(orClause, 'expected an $or scoping clause');
  const referrer = orClause.$or.find((c) => c.referredByUserId);
  const salesAgent = orClause.$or.find((c) => c.currentSalesAgentUserId);
  assert.equal(String(referrer.referredByUserId), String(user._id));
  assert.equal(String(salesAgent.currentSalesAgentUserId), String(user._id));
});

test('admin view (canSeeAll) is not self-scoped', async () => {
  const user = { _id: new mongoose.Types.ObjectId() };
  const mongo = await buildReferralLeadsMatch({ user, canSeeAll: true, query: {} });
  assert.deepEqual(mongo.referredByUserId, { $exists: true, $ne: null });
  assert.equal(mongo.$and, undefined);
});

// Status is NOT filtered in the base match anymore — it's filtered downstream on the computed
// `effectiveStatus` field (which mirrors the column badge: employee/resigned/job_removed/interview).
const NOW = new Date('2026-06-18T00:00:00Z');

test('base match does not constrain status (handled downstream on effectiveStatus)', async () => {
  const mongo = await buildReferralLeadsMatch({
    user: { _id: new mongoose.Types.ObjectId() },
    canSeeAll: true,
    query: { referralPipelineStatus: 'employee' },
  });
  assert.equal(mongo.referralPipelineStatus, undefined);
  assert.equal(mongo.joiningDate, undefined);
});

test('effectiveStatusMatch maps a selected status to a $match on effectiveStatus', () => {
  assert.deepEqual(effectiveStatusMatch({ referralPipelineStatus: 'job_removed' }), [
    { $match: { effectiveStatus: 'job_removed' } },
  ]);
  assert.deepEqual(effectiveStatusMatch({ referralPipelineStatus: '  hired ' }), [
    { $match: { effectiveStatus: 'hired' } },
  ]);
});

test('effectiveStatusMatch is empty when no status selected', () => {
  assert.deepEqual(effectiveStatusMatch({}), []);
  assert.deepEqual(effectiveStatusMatch({ referralPipelineStatus: '' }), []);
});

test('effectiveStatus $switch keeps badge precedence: employee > resigned > job_removed > interview', () => {
  const stages = buildEffectiveStatusStages(NOW);
  const setStage = stages.find((s) => s.$set && s.$set.effectiveStatus);
  const thens = setStage.$set.effectiveStatus.$switch.branches.map((b) => b.then);
  assert.deepEqual(thens, ['employee', 'resigned', 'job_removed', 'interview']);
  // job_removed must not override already-terminal statuses.
  assert.deepEqual(JOB_REMOVED_EXEMPT_FROM_TEST(stages), ['withdrawn', 'rejected', 'job_removed']);
});

// Pull the exempt list out of the compiled $switch so the test fails if it silently changes.
function JOB_REMOVED_EXEMPT_FROM_TEST(stages) {
  const setStage = stages.find((s) => s.$set && s.$set.effectiveStatus);
  const jobRemovedBranch = setStage.$set.effectiveStatus.$switch.branches.find((b) => b.then === 'job_removed');
  return jobRemovedBranch.case.$and[1].$not[0].$in[1];
}
