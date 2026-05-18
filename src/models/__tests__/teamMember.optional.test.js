import { test } from 'node:test';
import assert from 'node:assert/strict';
import TeamMember from '../team.model.js';

test('TeamMember.name is no longer required', () => {
  assert.equal(TeamMember.schema.paths.name.isRequired, undefined,
    'name should be optional so Excel-imported rows can omit it');
});

test('TeamMember.email is no longer required', () => {
  assert.equal(TeamMember.schema.paths.email.isRequired, undefined,
    'email should be optional so Excel-imported rows can omit it');
});

test('TeamMember.name retains trim option', () => {
  assert.equal(TeamMember.schema.paths.name.options.trim, true);
});

test('TeamMember.email retains trim option', () => {
  assert.equal(TeamMember.schema.paths.email.options.trim, true);
});

test('TeamMember.createdBy is still required', () => {
  assert.equal(TeamMember.schema.paths.createdBy.isRequired, true);
});

test('Excel-shaped doc validates without name/email', async () => {
  const ObjectId = (await import('mongoose')).default.Types.ObjectId;
  const doc = new TeamMember({
    employeeId: new ObjectId(),
    teamId: new ObjectId(),
    createdBy: new ObjectId(),
    seniority: 'Member',
    assignmentMode: 'excel-import',
  });
  const err = doc.validateSync();
  assert.equal(err, undefined, `validation failed: ${err?.message}`);
});
