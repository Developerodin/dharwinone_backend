import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _buildImportMetric, _buildExportMetric } from '../teamExcel.service.js';

test('_buildImportMetric returns structured event with derived ratios', () => {
  const m = _buildImportMetric({
    importLogId: 'l1', uploadedBy: 'u1', startedAt: Date.now() - 1000,
    summary: {
      rowsProcessed: 10, teamsCreated: 1, teamsUpdated: 0,
      employeesAdded: 6, employeesIgnored: 2, duplicatesSkipped: 1,
      ambiguousNames: 1, metadataConflicts: 0,
    },
    transactionRollbacks: 0,
    summaryUploadFailed: false,
    fileMeta: { size: 1234, hash: 'h' },
  });
  assert.equal(m.event, 'teams.import.completed');
  assert.equal(m.importLogId, 'l1');
  assert.ok(m.durationMs >= 1000);
  assert.equal(m.skippedRatio, 0.2);
  assert.equal(m.duplicateRatio, 0.1);
});

test('_buildExportMetric returns structured event', () => {
  const m = _buildExportMetric({
    startedAt: Date.now() - 500, teamsExported: 5,
    membersExported: 42, includeInactive: false,
  });
  assert.equal(m.event, 'teams.export.completed');
  assert.equal(m.teamsExported, 5);
  assert.ok(m.durationMs >= 500);
});
