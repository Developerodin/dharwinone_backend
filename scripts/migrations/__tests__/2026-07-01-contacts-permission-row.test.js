import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateRole } from '../2026-07-01-contacts-permission-row.js';

test('adds contacts row to a calling-enabled role', () => {
  const next = migrateRole(['communication.calling:view,create,edit,delete']);
  assert.ok(next.includes('communication.contacts:view,create,edit,delete'));
});

test('idempotent: no duplicate on re-run', () => {
  const once = migrateRole(['communication.calling:view', 'communication.contacts:view,create,edit,delete']);
  const twice = migrateRole(once);
  assert.deepEqual(twice, once);
});

test('leaves non-calling roles untouched', () => {
  const next = migrateRole(['ats.candidates:view']);
  assert.ok(!next.some((p) => p.startsWith('communication.contacts')));
});
