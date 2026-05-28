import test from 'node:test';
import assert from 'node:assert/strict';
import { canUpdateJoiningDate, canUpdateResignDate, canManageCandidates } from '../controllers/employee.controller.js';
import { getGrantingPermissions } from '../config/permissions.js';

const mkReq = (perms) => ({ authContext: { permissions: new Set(perms) } });

test('canUpdateJoiningDate: candidates.manage → true', () => {
  assert.equal(canUpdateJoiningDate(mkReq(['candidates.manage'])), true);
});
test('canUpdateJoiningDate: onboarding.manage → true', () => {
  assert.equal(canUpdateJoiningDate(mkReq(['onboarding.manage'])), true);
});
test('canUpdateJoiningDate: employees.manage → true', () => {
  assert.equal(canUpdateJoiningDate(mkReq(['employees.manage'])), true);
});
test('canUpdateJoiningDate: empty perms → false', () => {
  assert.equal(canUpdateJoiningDate(mkReq([])), false);
});
test('canUpdateJoiningDate: only candidates.read → false', () => {
  assert.equal(canUpdateJoiningDate(mkReq(['candidates.read'])), false);
});
test('canUpdateJoiningDate: legacy candidates.joiningDate.manage no longer granted', () => {
  assert.equal(canUpdateJoiningDate(mkReq(['candidates.joiningDate.manage'])), false);
});

test('canUpdateResignDate: candidates.manage → true', () => {
  assert.equal(canUpdateResignDate(mkReq(['candidates.manage'])), true);
});
test('canUpdateResignDate: employees.manage → true', () => {
  assert.equal(canUpdateResignDate(mkReq(['employees.manage'])), true);
});
test('canUpdateResignDate: onboarding.manage → false (resign date NOT under onboarding)', () => {
  assert.equal(canUpdateResignDate(mkReq(['onboarding.manage'])), false);
});
test('canUpdateResignDate: legacy candidates.resignDate.manage no longer granted', () => {
  assert.equal(canUpdateResignDate(mkReq(['candidates.resignDate.manage'])), false);
});

test('canManageCandidates: employees.manage → true', () => {
  assert.equal(canManageCandidates(mkReq(['employees.manage'])), true);
});
test('canManageCandidates: candidates.manage → true', () => {
  assert.equal(canManageCandidates(mkReq(['candidates.manage'])), true);
});
test('canManageCandidates: employees.read only → false', () => {
  assert.equal(canManageCandidates(mkReq(['employees.read'])), false);
});

test('getGrantingPermissions: employees.read includes ats.employees:view', () => {
  assert.ok(getGrantingPermissions('employees.read').includes('ats.employees:view'));
});
test('getGrantingPermissions: employees.manage includes ats.employees full bundle', () => {
  assert.ok(getGrantingPermissions('employees.manage').includes('ats.employees:view,create,edit,delete'));
});
