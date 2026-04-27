import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerifyEmailUpdatePlan,
  buildVerifyEmailAggregationPipeline,
} from './auth.verifyEmailUpdate.js';

const cid = '507f1f77bcf86cd799439011';
const sid = '507f191e810c19729de860ea';

describe('buildVerifyEmailUpdatePlan', () => {
  it('staff skip: email verified only', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'pending', eligibleForCandidateAutoActivate: true },
      { skipStaffAutoActivate: true, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(plan.scalarSet, { isEmailVerified: true });
    assert.equal(plan.pendingToActive, false);
    assert.equal(plan.applyRoleIdsInDb, false);
  });

  it('public_generic: verify only, stays pending', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'pending', eligibleForCandidateAutoActivate: false },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(plan.scalarSet, { isEmailVerified: true });
    assert.equal(plan.pendingToActive, false);
    assert.equal(plan.applyRoleIdsInDb, false);
  });

  it('eligible pending: activate + pipeline role merge', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'pending', eligibleForCandidateAutoActivate: true, roleIds: [sid] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(plan.scalarSet, {
      isEmailVerified: true,
      status: 'active',
    });
    assert.equal(plan.pendingToActive, true);
    assert.equal(plan.applyRoleIdsInDb, true);
    const pipe = buildVerifyEmailAggregationPipeline(plan);
    assert.ok(pipe && pipe[0].$set.roleIds);
    assert.equal(pipe[0].$set.isEmailVerified, true);
    assert.equal(pipe[0].$set.status, 'active');
  });

  it('eligible active: verify + role fix in pipeline, no status in scalar set', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'active', eligibleForCandidateAutoActivate: true, roleIds: [sid] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(plan.scalarSet, { isEmailVerified: true });
    assert.equal(plan.pendingToActive, false);
    assert.equal(plan.applyRoleIdsInDb, true);
  });

  it('disabled: verify only', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'disabled', eligibleForCandidateAutoActivate: true },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(plan.scalarSet, { isEmailVerified: true });
    assert.equal(plan.applyRoleIdsInDb, false);
  });

  it('no student role id: pipeline still merges candidate', () => {
    const plan = buildVerifyEmailUpdatePlan(
      { status: 'pending', eligibleForCandidateAutoActivate: true, roleIds: [] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: null }
    );
    assert.equal(plan.applyRoleIdsInDb, true);
    const pipe = buildVerifyEmailAggregationPipeline(plan);
    assert.ok(pipe && pipe[0].$set.roleIds);
  });

  it('legacy job applicant: sets registrationSource when flag set', () => {
    const plan = buildVerifyEmailUpdatePlan(
      {
        status: 'pending',
        eligibleForCandidateAutoActivate: true,
        setRegistrationSourcePublicCandidate: true,
      },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: null }
    );
    assert.equal(plan.scalarSet.registrationSource, 'public_candidate');
  });
});
