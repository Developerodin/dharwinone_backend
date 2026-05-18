import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows } from '../normalizeTeamRows.js';

const rows = [
  { 'Team Name': ' Alpha Team ', 'Department': 'Engineering', 'Description': '',  'Employee Email': 'A@DHARWIN.com', 'Team Seniority': 'Lead' },
  { 'Team Name': 'alpha team',   'Department': 'Marketing',   'Description': 'X', 'Employee ID': 'DBS101' },
  { 'Team Name': 'Beta Team',    'Employee Name': 'Bharat' },
  { 'Team Name': '',             'Employee ID': 'DBS999' },
];

test('groups by case-insensitive team name', () => {
  const out = normalizeRows(rows);
  assert.equal(out.teams.size, 2);
  assert.ok(out.teams.has('alpha team'));
  assert.ok(out.teams.has('beta team'));
});
test('first non-empty metadata wins; conflicts logged', () => {
  const out = normalizeRows(rows);
  const alpha = out.teams.get('alpha team');
  assert.equal(alpha.meta.department, 'Engineering');
  assert.equal(alpha.meta.description, 'X');
  assert.deepEqual(alpha.metadataConflicts, [
    { field: 'department', kept: 'Engineering', ignored: 'Marketing' }
  ]);
});
test('emails lowercased; team-name-empty rows dropped', () => {
  const out = normalizeRows(rows);
  const alpha = out.teams.get('alpha team');
  assert.equal(alpha.memberRows[0].employeeEmail, 'a@dharwin.com');
  const allRows = [...out.teams.values()].flatMap((t) => t.memberRows);
  assert.equal(allRows.length, 3);
});
test('unknown columns appear in warnings.unknownColumns', () => {
  const out = normalizeRows([{ 'Team Name': 'X', 'Manager': 'Y' }]);
  assert.deepEqual(out.warnings.unknownColumns, ['Manager']);
});
