import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _emptySummary, _mergeTeamResult } from '../teamExcel.service.js';

test('_emptySummary has all required counters', () => {
  const s = _emptySummary();
  for (const k of ['teamsCreated','teamsUpdated','employeesAdded','employeesIgnored',
                   'duplicatesSkipped','ambiguousNames','teamLeadSkipped','metadataConflicts',
                   'rowsProcessed']) {
    assert.equal(s[k], 0);
  }
  assert.deepEqual(s.details.skipped, []);
});

test('_mergeTeamResult increments correct counters', () => {
  const s = _emptySummary();
  _mergeTeamResult(s, {
    team: { name: 'Alpha' },
    isNewTeam: true,
    plan: {
      toInsert: [{ employeeId: 'o1' }, { employeeId: 'o2' }],
      duplicates: [{ employeeId: 'o3', reason: 'already_in_team' }],
      skipped: [
        { reason: 'inactive_or_resigned', row: { employeeEmail: 'x@y.com' } },
        { reason: 'ambiguous_employee_name', row: { employeeName: 'X' }, matchCount: 3 },
      ],
    },
    metadataConflicts: [{ field: 'department', kept: 'A', ignored: 'B' }],
    createdSheetExtras: {
      department: 'Engineering',
      leadName: 'Pat',
      leadEmail: 'pat@x.com',
      providedLeadEmail: '',
    },
  });
  assert.equal(s.teamsCreated, 1);
  assert.equal(s.employeesAdded, 2);
  assert.equal(s.duplicatesSkipped, 1);
  assert.equal(s.employeesIgnored, 1);
  assert.equal(s.ambiguousNames, 1);
  assert.equal(s.metadataConflicts, 1);
  assert.deepEqual(s._created[0], {
    'Team Name': 'Alpha',
    Lead: 'Pat — pat@x.com',
    Department: 'Engineering',
    'Members count': 2,
  });
});
