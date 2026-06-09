import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canFullEmployeeRecordEdit,
  canMutateEmployeeRecord,
  restrictToOnboardingPatchFields,
  canSyncAcceptedOfferCanon,
} from '../employeeUpdateAuth.helper.js';

const candidate = { owner: 'owner1' };

test('canFullEmployeeRecordEdit allows manage candidates or employees.edit', () => {
  assert.equal(canFullEmployeeRecordEdit({ canManageCandidates: true }), true);
  assert.equal(canFullEmployeeRecordEdit({ canEditEmployees: true }), true);
  assert.equal(canFullEmployeeRecordEdit({ canOnboardingEdit: true }), false);
});

test('canMutateEmployeeRecord allows onboarding editors', () => {
  assert.equal(canMutateEmployeeRecord({ canOnboardingEdit: true }, candidate), true);
  assert.equal(canMutateEmployeeRecord({ id: 'owner1' }, candidate), true);
  assert.equal(canMutateEmployeeRecord({ id: 'other' }, candidate), false);
});

test('restrictToOnboardingPatchFields strips disallowed keys', () => {
  const out = restrictToOnboardingPatchFields({
    departmentId: 'd1',
    joiningDate: '2026-01-01',
    email: 'x@y.com',
  });
  assert.deepEqual(out, { departmentId: 'd1' });
});

test('canSyncAcceptedOfferCanon requires full edit rights', () => {
  assert.equal(canSyncAcceptedOfferCanon({ canManageCandidates: true }), true);
  assert.equal(canSyncAcceptedOfferCanon({ canOnboardingEdit: true }), false);
});
