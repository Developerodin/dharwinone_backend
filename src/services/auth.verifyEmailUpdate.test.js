import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyEmailMongoUpdate } from './auth.verifyEmailUpdate.js';

const cid = '507f1f77bcf86cd799439011';
const sid = '507f191e810c19729de860ea';

describe('buildVerifyEmailMongoUpdate', () => {
  it('staff skip: email verified only', () => {
    const { mongoUpdate, pendingToActive } = buildVerifyEmailMongoUpdate(
      { status: 'pending', eligibleForCandidateAutoActivate: true },
      { skipStaffAutoActivate: true, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(mongoUpdate, { $set: { isEmailVerified: true } });
    assert.equal(pendingToActive, false);
  });

  it('public_generic: verify only, stays pending', () => {
    const { mongoUpdate, pendingToActive } = buildVerifyEmailMongoUpdate(
      { status: 'pending', eligibleForCandidateAutoActivate: false },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(mongoUpdate, { $set: { isEmailVerified: true } });
    assert.equal(pendingToActive, false);
  });

  it('eligible pending: activate, merge roleIds (Candidate in, Student out)', () => {
    const { mongoUpdate, pendingToActive } = buildVerifyEmailMongoUpdate(
      { status: 'pending', eligibleForCandidateAutoActivate: true, roleIds: [sid] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(mongoUpdate.$set, {
      isEmailVerified: true,
      status: 'active',
      roleIds: [cid],
    });
    assert.equal(pendingToActive, true);
  });

  it('eligible active: verify + role fix, no status change in set beyond verified + roleIds', () => {
    const { mongoUpdate, pendingToActive } = buildVerifyEmailMongoUpdate(
      { status: 'active', eligibleForCandidateAutoActivate: true, roleIds: [sid] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(mongoUpdate.$set, { isEmailVerified: true, roleIds: [cid] });
    assert.equal(pendingToActive, false);
  });

  it('disabled: verify only', () => {
    const { mongoUpdate, pendingToActive } = buildVerifyEmailMongoUpdate(
      { status: 'disabled', eligibleForCandidateAutoActivate: true },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: sid }
    );
    assert.deepEqual(mongoUpdate, { $set: { isEmailVerified: true } });
    assert.equal(pendingToActive, false);
  });

  it('no student role id: only add Candidate to roleIds', () => {
    const { mongoUpdate } = buildVerifyEmailMongoUpdate(
      { status: 'pending', eligibleForCandidateAutoActivate: true, roleIds: [] },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: null }
    );
    assert.deepEqual(mongoUpdate.$set.roleIds, [cid]);
  });

  it('legacy job applicant: sets registrationSource when flag set', () => {
    const { mongoUpdate } = buildVerifyEmailMongoUpdate(
      {
        status: 'pending',
        eligibleForCandidateAutoActivate: true,
        setRegistrationSourcePublicCandidate: true,
      },
      { skipStaffAutoActivate: false, candidateRoleId: cid, studentRoleId: null }
    );
    assert.equal(mongoUpdate.$set.registrationSource, 'public_candidate');
  });
});
