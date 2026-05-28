import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeActions,
  migrateRole,
  projectMigrationLogSize,
  BSON_SIZE_BUDGET_BYTES,
} from '../2026-05-28-ats-employees-permission-row.js';

test('normalizeActions: reorders to canonical view,create,edit,delete', () => {
  assert.equal(
    normalizeActions('ats.candidates:create,view,edit,delete'),
    'ats.candidates:view,create,edit,delete'
  );
});

test('normalizeActions: single action passes through', () => {
  assert.equal(normalizeActions('ats.employees:edit'), 'ats.employees:edit');
});

test('normalizeActions: literal keys (no colon) pass through', () => {
  assert.equal(normalizeActions('candidates.read'), 'candidates.read');
});

test('normalizeActions: dedupes duplicate actions', () => {
  assert.equal(
    normalizeActions('ats.employees:view,view,edit'),
    'ats.employees:view,edit'
  );
});

test('normalizeActions: empty actions list preserves "feature:"', () => {
  assert.equal(normalizeActions('ats.employees:'), 'ats.employees:');
});

test('migrateRole: mirrors full CRUD', () => {
  const { next, added, removed } = migrateRole(['ats.candidates:view,create,edit,delete']);
  assert.ok(next.includes('ats.employees:view,create,edit,delete'));
  assert.ok(next.includes('ats.candidates:view,create,edit,delete'));
  assert.deepEqual(added, ['ats.employees:view,create,edit,delete']);
  assert.deepEqual(removed, []);
});

test('migrateRole: mirrors view-only', () => {
  const { next, added } = migrateRole(['ats.candidates:view']);
  assert.ok(next.includes('ats.employees:view'));
  assert.deepEqual(added, ['ats.employees:view']);
});

test('migrateRole: removes deprecated derived literal key without auto-adding employees.manage', () => {
  const { next, added, removed } = migrateRole(['candidates.joiningDate.manage']);
  assert.equal(next.includes('candidates.joiningDate.manage'), false);
  assert.equal(next.includes('employees.manage'), false);
  assert.deepEqual(removed, ['candidates.joiningDate.manage']);
  assert.deepEqual(added, []);
});

test('migrateRole: removes deprecated RAW sub-row prefix (joiningDate)', () => {
  const { next, removed } = migrateRole(['ats.candidates.joiningDate:view,edit']);
  assert.equal(next.includes('ats.candidates.joiningDate:view,edit'), false);
  assert.deepEqual(removed, ['ats.candidates.joiningDate:view,edit']);
});

test('migrateRole: removes deprecated RAW sub-row prefix (resignDate)', () => {
  const { next, removed } = migrateRole(['ats.candidates.resignDate:view']);
  assert.equal(next.includes('ats.candidates.resignDate:view'), false);
  assert.deepEqual(removed, ['ats.candidates.resignDate:view']);
});

test('migrateRole: preserves unrelated permission strings verbatim (no normalization)', () => {
  const { next } = migrateRole(['ats.analytics:view,export']);
  assert.equal(next.includes('ats.analytics:view,export'), true);
  assert.equal(next.includes('ats.analytics:export,view'), false);
});

test('migrateRole: idempotent — already-migrated input', () => {
  const migrated = ['ats.candidates:view,create,edit,delete', 'ats.employees:view,create,edit,delete'];
  const { next, added, removed } = migrateRole(migrated);
  assert.equal(next.length, migrated.length);
  for (const p of migrated) assert.ok(next.includes(p));
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test('migrateRole: dedupes mirrors when source has both view and full bundle', () => {
  const { next, added } = migrateRole(['ats.candidates:view', 'ats.candidates:view,create,edit,delete']);
  assert.equal(next.filter((p) => p === 'ats.employees:view').length, 1);
  assert.equal(next.filter((p) => p === 'ats.employees:view,create,edit,delete').length, 1);
  assert.equal(added.length, 2);
});

test('migrateRole: preserves source ordering, normalizes only the mirror', () => {
  const { next } = migrateRole(['ats.candidates:create,view,edit,delete']);
  assert.ok(next.includes('ats.candidates:create,view,edit,delete'));
  assert.ok(next.includes('ats.employees:view,create,edit,delete'));
});

test('projectMigrationLogSize: small role gives small projection', () => {
  const size = projectMigrationLogSize(
    ['ats.candidates:view'],
    ['ats.candidates:view', 'ats.employees:view']
  );
  assert.ok(size < 1024, `expected < 1024, got ${size}`);
});

test('projectMigrationLogSize: large permission strings exceed 12MB budget', () => {
  const huge = Array.from({ length: 30 }, () => `ats.candidates:${'a'.repeat(500000)}`);
  const size = projectMigrationLogSize(huge, huge);
  assert.ok(size > BSON_SIZE_BUDGET_BYTES, `expected > ${BSON_SIZE_BUDGET_BYTES}, got ${size}`);
});
