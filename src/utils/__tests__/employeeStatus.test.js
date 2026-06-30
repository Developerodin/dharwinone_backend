import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExistingEmployee, isResignedEmployee } from '../employeeStatus.js';

test('isExistingEmployee: true when a permanent employeeId is set', () => {
  assert.equal(isExistingEmployee({ employeeId: 'DBS42' }), true);
  assert.equal(isExistingEmployee({ employeeId: '  DBS7  ' }), true);
});

test('isExistingEmployee: true for staff referral pipeline statuses', () => {
  for (const status of ['employee', 'joined', 'resigned']) {
    assert.equal(isExistingEmployee({ referralPipelineStatus: status }), true, status);
  }
});

test('isExistingEmployee: false for in-flight pipeline (still external hire, no employeeId yet)', () => {
  for (const status of ['applied', 'interview', 'offer', 'preboarding', 'hired', 'pending']) {
    assert.equal(isExistingEmployee({ referralPipelineStatus: status }), false, status);
  }
  assert.equal(isExistingEmployee({ employeeId: '' }), false);
  assert.equal(isExistingEmployee({}), false);
  assert.equal(isExistingEmployee(null), false);
});

test('isResignedEmployee: true for resigned status or inactive record', () => {
  assert.equal(isResignedEmployee({ referralPipelineStatus: 'resigned' }), true);
  assert.equal(isResignedEmployee({ isActive: false }), true);
});

test('isResignedEmployee: false for an active employee', () => {
  assert.equal(isResignedEmployee({ referralPipelineStatus: 'employee', isActive: true }), false);
  assert.equal(isResignedEmployee({ employeeId: 'DBS9', isActive: true }), false);
  assert.equal(isResignedEmployee(null), false);
});

// The transfer routing invariant: an active employee transfers; a resigned one does NOT (rehire).
test('routing invariant: active employee = transfer-eligible, resigned = rehire', () => {
  const active = { employeeId: 'DBS1', referralPipelineStatus: 'employee', isActive: true };
  const resigned = { employeeId: 'DBS1', referralPipelineStatus: 'resigned', isActive: false };
  assert.equal(isExistingEmployee(active) && !isResignedEmployee(active), true);
  assert.equal(isExistingEmployee(resigned) && !isResignedEmployee(resigned), false);
});
