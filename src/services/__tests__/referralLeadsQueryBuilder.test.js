import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  buildLeadMatchStage,
  applyNewFilters,
  buildSalesAgentEnrichment,
  buildLifecycleStageProjection,
} from '../referralLeadsQueryBuilder.js';

test('buildLeadMatchStage applies salesAgentUserId filter', () => {
  const id = new mongoose.Types.ObjectId();
  const match = buildLeadMatchStage({ salesAgentUserId: id }, {});
  assert.equal(String(match.currentSalesAgentUserId), String(id));
});

test('buildLeadMatchStage handles unassigned=true', () => {
  const match = buildLeadMatchStage({ unassigned: true }, {});
  assert.equal(match.currentSalesAgentUserId, null);
});

test('applyNewFilters handles hiredOnly', () => {
  const match = applyNewFilters({ hiredOnly: true });
  assert.equal(match.referralPipelineStatus, 'hired');
});

test('buildSalesAgentEnrichment $lookup attaches current attribution', () => {
  const stages = buildSalesAgentEnrichment();
  assert.equal(stages[0].$lookup.from, 'users');
  assert.equal(stages[0].$lookup.localField, 'currentSalesAgentUserId');
});

test('buildLifecycleStageProjection adds derived lifecycleStage field', () => {
  const stage = buildLifecycleStageProjection();
  assert.ok(stage.$set.lifecycleStage);
  assert.ok(stage.$set.employeeConverted);
});
