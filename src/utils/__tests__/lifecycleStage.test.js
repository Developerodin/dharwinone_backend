import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLifecycleStage, deriveEmployeeStatus, isActiveEmployee } from '../lifecycleStage.js';

const now = new Date('2026-06-01T00:00:00Z');

test('joined active employee -> employee', () => {
  const emp = { joiningDate: new Date('2026-01-01'), isActive: true, referralPipelineStatus: 'hired' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: false, anyOffer: false }), 'employee');
});

test('future joining date -> joined_pending_start', () => {
  const emp = { joiningDate: new Date('2026-07-01'), isActive: true, referralPipelineStatus: 'hired' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: false, anyOffer: false }), 'joined_pending_start');
});

test('accepted offer, no join date -> preboarding', () => {
  const emp = { joiningDate: null, isActive: true, referralPipelineStatus: 'hired' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: true, anyOffer: true }), 'preboarding');
});

test('any offer, not accepted -> offered', () => {
  const emp = { joiningDate: null, referralPipelineStatus: 'in_review' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: false, anyOffer: true }), 'offered');
});

test('in_review or has interview -> interview', () => {
  const emp = { referralPipelineStatus: 'in_review' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: false, anyOffer: false }), 'interview');
});

test('applied -> applied', () => {
  const emp = { referralPipelineStatus: 'applied' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: false, anyOffer: false }), 'applied');
});

test('isActiveEmployee true when joined and active', () => {
  assert.equal(
    isActiveEmployee({ joiningDate: new Date('2026-01-01'), isActive: true }, { now }),
    true
  );
});

test('isActiveEmployee false when join date in future', () => {
  assert.equal(
    isActiveEmployee({ joiningDate: new Date('2026-07-01'), isActive: true }, { now }),
    false
  );
});

test('default -> pending', () => {
  assert.equal(deriveLifecycleStage({ referralPipelineStatus: 'pending' }, { now }), 'pending');
});

test('joined inactive employee -> resigned (not preboarding/offered fallthrough)', () => {
  const emp = { joiningDate: new Date('2026-01-01'), isActive: false, referralPipelineStatus: 'hired' };
  assert.equal(deriveLifecycleStage(emp, { now, acceptedOffer: true, anyOffer: true }), 'resigned');
});

test('deriveEmployeeStatus: active / resigned / null', () => {
  assert.equal(deriveEmployeeStatus({ joiningDate: new Date('2026-01-01'), isActive: true }, { now }), 'active');
  assert.equal(deriveEmployeeStatus({ joiningDate: new Date('2026-01-01'), isActive: false }, { now }), 'resigned');
  assert.equal(deriveEmployeeStatus({ joiningDate: new Date('2026-07-01'), isActive: true }, { now }), null);
  assert.equal(deriveEmployeeStatus({ joiningDate: null, isActive: true }, { now }), null);
});
