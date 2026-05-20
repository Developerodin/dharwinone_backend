import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeamMember,
  linkOrphan,
  softRemoveTeamMember,
  moveTeamMember,
  updateTeamMember,
} from '../team.validation.js';

const oid = '507f1f77bcf86cd799439011';

test('createTeamMember accepts a linked payload', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid, employeeId: oid });
  assert.equal(error, undefined);
});
test('createTeamMember accepts an orphan payload', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid, legacyName: 'Jane', legacyEmail: 'jane@x.com' });
  assert.equal(error, undefined);
});
test('createTeamMember rejects employeeId + legacyName together', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid, employeeId: oid, legacyName: 'X' });
  assert.ok(error);
});
test('createTeamMember rejects neither employeeId nor legacy*', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid });
  assert.ok(error);
});
test('createTeamMember defaults assignmentMode to manual', () => {
  const { value } = createTeamMember.body.validate({ teamId: oid, employeeId: oid });
  assert.equal(value.assignmentMode, 'manual');
});
test('createTeamMember still allows excel-import assignmentMode', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid, employeeId: oid, assignmentMode: 'excel-import' });
  assert.equal(error, undefined);
});
test('createTeamMember rejects unknown assignmentMode', () => {
  const { error } = createTeamMember.body.validate({ teamId: oid, employeeId: oid, assignmentMode: 'bogus' });
  assert.ok(error);
});
test('linkOrphan body requires employeeId', () => {
  assert.ok(linkOrphan.body.validate({}).error);
  assert.equal(linkOrphan.body.validate({ employeeId: oid }).error, undefined);
});
test('softRemoveTeamMember body requires removedReason', () => {
  assert.ok(softRemoveTeamMember.body.validate({}).error);
  assert.equal(softRemoveTeamMember.body.validate({ removedReason: 'left' }).error, undefined);
});
test('moveTeamMember body requires teamId', () => {
  assert.ok(moveTeamMember.body.validate({}).error);
  assert.equal(moveTeamMember.body.validate({ teamId: oid }).error, undefined);
});
test('updateTeamMember body rejects teamId', () => {
  assert.ok(updateTeamMember.body.validate({ teamId: oid }).error);
});
