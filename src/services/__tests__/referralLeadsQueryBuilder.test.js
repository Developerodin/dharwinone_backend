import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  buildLeadMatchStage,
  applyNewFilters,
  buildSalesAgentEnrichment,
  buildLifecycleStageProjection,
} from '../referralLeadsQueryBuilder.js';
import {
  quickFilterEffectiveStatusMatch,
  QUICK_HIRED_EFFECTIVE_STATUSES,
  QUICK_APPLIED_EFFECTIVE_STATUSES,
} from '../referralLeads.service.js';

test('buildLeadMatchStage applies salesAgentUserId filter', () => {
  const id = new mongoose.Types.ObjectId();
  const match = buildLeadMatchStage({ salesAgentUserId: id }, {});
  assert.equal(String(match.currentSalesAgentUserId), String(id));
});

test('buildLeadMatchStage handles unassigned=true', () => {
  const match = buildLeadMatchStage({ unassigned: true }, {});
  assert.equal(match.currentSalesAgentUserId, null);
});

test('applyNewFilters no longer maps hiredOnly to raw referralPipelineStatus', () => {
  const match = applyNewFilters({ hiredOnly: true });
  assert.equal(match.referralPipelineStatus, undefined);
});

test('quickFilterEffectiveStatusMatch handles hiredOnly on effectiveStatus', () => {
  const stages = quickFilterEffectiveStatusMatch({ hiredOnly: true });
  assert.deepEqual(stages[0].$match.effectiveStatus.$in, QUICK_HIRED_EFFECTIVE_STATUSES);
  assert.deepEqual(stages[0].$match.effectiveStatus.$in, ['hired']);
});

test('quickFilterEffectiveStatusMatch handles appliedOnly on effectiveStatus', () => {
  const stages = quickFilterEffectiveStatusMatch({ appliedOnly: true });
  assert.deepEqual(stages[0].$match.effectiveStatus.$in, QUICK_APPLIED_EFFECTIVE_STATUSES);
  assert.deepEqual(stages[0].$match.effectiveStatus.$in, ['applied']);
});

test('quickFilterEffectiveStatusMatch handles employeeStatus=active', () => {
  const stages = quickFilterEffectiveStatusMatch({ employeeStatus: 'active' });
  assert.equal(stages[0].$match.effectiveStatus, 'employee');
});

test('quickFilterEffectiveStatusMatch handles employeeStatus=resigned', () => {
  const stages = quickFilterEffectiveStatusMatch({ employeeStatus: 'resigned' });
  assert.equal(stages[0].$match.effectiveStatus, 'resigned');
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

test('applyNewFilters supports convertedEmployees filter', () => {
  const match = applyNewFilters({ convertedEmployees: true });
  assert.ok(match.joiningDate.$lte instanceof Date);
});
