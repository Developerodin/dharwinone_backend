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
  assert.deepEqual(match.referralPipelineStatus, { $in: ['hired', 'joined', 'employee'] });
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
  assert.ok(stage.$set.employeeStatus);
});

test('lifecycleStage projection maps joined+inactive to resigned', () => {
  const branches = buildLifecycleStageProjection().$set.lifecycleStage.$switch.branches;
  const thens = branches.map((b) => b.then);
  assert.ok(thens.includes('resigned'));
  // resigned must rank above joined_pending_start fallthrough but below active employee
  assert.equal(thens.indexOf('employee') < thens.indexOf('resigned'), true);
});

test('employeeConverted stays true regardless of isActive (historical fact)', () => {
  const cond = buildLifecycleStageProjection().$set.employeeConverted.$cond[0];
  assert.equal(JSON.stringify(cond).includes('isActive'), false);
});

test('applyNewFilters employeeStatus=active matches active joined employees', () => {
  const match = applyNewFilters({ employeeStatus: 'active' });
  assert.equal(match.isActive, true);
  assert.ok(match.joiningDate.$lte instanceof Date);
});

test('applyNewFilters employeeStatus=resigned matches inactive joined employees', () => {
  const match = applyNewFilters({ employeeStatus: 'resigned' });
  assert.deepEqual(match.isActive, { $ne: true });
  assert.ok(match.joiningDate.$lte instanceof Date);
});
