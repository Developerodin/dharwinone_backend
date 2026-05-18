import { test } from 'node:test';
import assert from 'node:assert/strict';
import TeamMember from '../team.model.js';

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

test('TeamMember has compound unique index on (teamId, employeeId)', () => {
  const idx = TeamMember.schema.indexes().find(([fields]) =>
    fields.teamId === 1 && fields.employeeId === 1
  );
  assert.ok(idx, 'compound (teamId, employeeId) index missing');
  assert.equal(idx[1].unique, true);
});
