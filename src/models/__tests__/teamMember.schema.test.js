import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import TeamMember, { deriveDisplayFields, buildRoleSnapshot } from '../team.model.js';

test('TeamMember schema exposes employeeId, seniority, assignmentMode', () => {
  const paths = TeamMember.schema.paths;
  assert.ok(paths.employeeId, 'employeeId missing');
  assert.equal(paths.employeeId.options.ref, 'Employee');
  assert.ok(paths.seniority, 'seniority missing');
  assert.ok(paths.assignmentMode, 'assignmentMode missing');
  assert.deepEqual(
    paths.assignmentMode.enumValues.sort(),
    ['ai-suggested', 'excel-import', 'manual', 'position-auto'].sort()
  );
});

test('TeamMember has partial-unique index on active linked rows', () => {
  const idx = TeamMember.schema.indexes().find(([def]) => def.teamId === 1 && def.employeeId === 1);
  assert.ok(idx, 'expected a { teamId, employeeId } index');
  assert.equal(idx[1].unique, true);
  assert.ok(idx[1].partialFilterExpression, 'expected partialFilterExpression');
});

test('TeamMember accepts orphan fields legacyName/legacyEmail/orphanReason', () => {
  const tm = new TeamMember({
    teamId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    legacyName: 'Jane Doe',
    legacyEmail: 'jane@x.com',
    orphanReason: 'no_email_match',
    orphanDetectedAt: new Date(),
  });
  assert.equal(tm.legacyName, 'Jane Doe');
  assert.equal(tm.orphanReason, 'no_email_match');
});
test('TeamMember soft-remove fields default correctly', () => {
  const tm = new TeamMember({ teamId: new mongoose.Types.ObjectId(), createdBy: new mongoose.Types.ObjectId() });
  assert.equal(tm.isActive, true);
  assert.equal(tm.removedAt, null);
});
test('TeamMember rejects assignmentMode outside enum', () => {
  const tm = new TeamMember({
    teamId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    assignmentMode: 'bogus',
  });
  const err = tm.validateSync();
  assert.ok(err && err.errors.assignmentMode, 'expected assignmentMode validation error');
});
test('TeamMember still accepts excel-import assignmentMode', () => {
  const tm = new TeamMember({
    teamId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    assignmentMode: 'excel-import',
  });
  assert.equal(tm.validateSync(), undefined);
});
test('TeamMember no longer has a teamGroup path', () => {
  assert.equal(TeamMember.schema.path('teamGroup'), undefined);
});
test('deriveDisplayFields uses populated Employee when present', () => {
  const out = deriveDisplayFields({
    employeeId: { fullName: 'Linked Person', companyAssignedEmail: 'lp@co.com', profilePicture: { url: 'http://p' } },
  });
  assert.deepEqual(out, { displayName: 'Linked Person', displayEmail: 'lp@co.com', avatarUrl: 'http://p', isOrphan: false });
});
test('deriveDisplayFields falls back to legacy fields for orphan', () => {
  const out = deriveDisplayFields({ employeeId: null, legacyName: 'Ghost', legacyEmail: 'g@x.com' });
  assert.deepEqual(out, { displayName: 'Ghost', displayEmail: 'g@x.com', avatarUrl: null, isOrphan: true });
});
test('TeamMember accepts a roleSnapshot subdocument', () => {
  const tm = new TeamMember({
    teamId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    employeeId: new mongoose.Types.ObjectId(),
    roleSnapshot: { designation: 'Senior Frontend Engineer', department: 'Engineering', seniority: 'Senior', capturedAt: new Date() },
  });
  assert.equal(tm.roleSnapshot.designation, 'Senior Frontend Engineer');
  assert.equal(tm.roleSnapshot.department, 'Engineering');
});
test('buildRoleSnapshot copies designation/department off the Employee', () => {
  const snap = buildRoleSnapshot({ designation: 'QA Engineer', department: 'Quality' }, 'Mid');
  assert.equal(snap.designation, 'QA Engineer');
  assert.equal(snap.department, 'Quality');
  assert.equal(snap.seniority, 'Mid');
  assert.ok(snap.capturedAt instanceof Date);
});
test('buildRoleSnapshot returns undefined when no Employee is given', () => {
  assert.equal(buildRoleSnapshot(null, 'Senior'), undefined);
});
