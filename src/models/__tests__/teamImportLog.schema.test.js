import { test } from 'node:test';
import assert from 'node:assert/strict';
import TeamImportLog from '../teamImportLog.model.js';

test('TeamImportLog has required summary count fields', () => {
  const p = TeamImportLog.schema.paths;
  for (const f of [
    'uploadedBy',
    'fileHash',
    'rowsProcessed',
    'teamsCreated',
    'teamsUpdated',
    'employeesAdded',
    'employeesIgnored',
    'duplicatesSkipped',
    'ambiguousNames',
    'teamLeadSkipped',
    'metadataConflicts',
    'summaryFileKey',
  ]) {
    assert.ok(p[f], `${f} missing`);
  }
});

test('TeamImportLog has TTL index on createdAt (365 days)', () => {
  const ttl = TeamImportLog.schema
    .indexes()
    .find(([fields, opts]) => fields.createdAt && opts.expireAfterSeconds);
  assert.ok(ttl, 'TTL index missing');
  assert.equal(ttl[1].expireAfterSeconds, 60 * 60 * 24 * 365);
});
