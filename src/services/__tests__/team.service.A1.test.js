import test from 'node:test';
import assert from 'node:assert/strict';
import { findDroppedFields, DROPPED_TEAMMEMBER_FIELDS } from '../team.service.js';

test('findDroppedFields returns [] for a clean payload', () => {
  assert.deepEqual(findDroppedFields({ teamId: 'a', employeeId: 'b' }), []);
});
test('findDroppedFields flags denormalized fields', () => {
  const found = findDroppedFields({ teamId: 'a', name: 'X', teamGroup: 'team_ui' });
  assert.deepEqual(found.sort(), ['name', 'teamGroup']);
});
test('DROPPED_TEAMMEMBER_FIELDS includes the legacy roster fields', () => {
  for (const f of ['name', 'email', 'teamGroup', 'onlineStatus']) {
    assert.ok(DROPPED_TEAMMEMBER_FIELDS.includes(f), `${f} missing`);
  }
});
