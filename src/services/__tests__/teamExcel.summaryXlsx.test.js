import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { buildSummaryWorkbookBuffer } from '../teamExcel.service.js';

test('buildSummaryWorkbookBuffer produces a workbook with 4 named sheets', () => {
  const buf = buildSummaryWorkbookBuffer({
    summary: {
      teamsCreated: 1, teamsUpdated: 0, employeesAdded: 2, employeesIgnored: 1,
      duplicatesSkipped: 0, ambiguousNames: 0, teamLeadSkipped: 0, metadataConflicts: 0,
      rowsProcessed: 3,
      details: {
        skipped: [{ team: 'Alpha', identifier: 'x@y.com', reason: 'inactive_or_resigned' }],
        duplicates: [], metadataConflicts: [], teamLeadSkipped: [], warnings: [],
      },
      _created: [
        {
          'Team Name': 'Alpha',
          Lead: 'Pat — pat@x.com',
          Department: 'Engineering',
          'Members count': 2,
        },
      ],
      _updated: [],
    },
    fileMeta: { fileName: 't.xlsx', uploadedBy: 'u1', uploadedAt: new Date().toISOString(), fileHash: 'h' },
  });
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames.sort(), ['Created', 'Overview', 'Skipped', 'Updated']);
});
