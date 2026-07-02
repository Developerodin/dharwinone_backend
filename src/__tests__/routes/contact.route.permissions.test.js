import test from 'node:test';
import assert from 'node:assert/strict';
import { getGrantingPermissions } from '../../config/permissions.js';

test('contacts.* aliases resolve (domain + api forms)', () => {
  assert.ok(getGrantingPermissions('contacts.view').includes('contacts.view'));
  assert.ok(getGrantingPermissions('contacts.create').includes('contacts.create'));
  assert.ok(getGrantingPermissions('contacts.delete').includes('contacts.delete'));
});

// Contacts are governed by the Calling (dialer) permission — no separate toggle.
test('contacts.* are granted by communication.calling:* tokens', () => {
  assert.ok(getGrantingPermissions('contacts.view').includes('communication.calling:view'));
  assert.ok(getGrantingPermissions('contacts.create').includes('communication.calling:create'));
  assert.ok(getGrantingPermissions('contacts.edit').includes('communication.calling:edit'));
  assert.ok(getGrantingPermissions('contacts.delete').includes('communication.calling:delete'));
  // Full dialer CRUD grants every contact action.
  const full = 'communication.calling:view,create,edit,delete';
  for (const p of ['contacts.view', 'contacts.create', 'contacts.edit', 'contacts.delete']) {
    assert.ok(getGrantingPermissions(p).includes(full), `${p} should be granted by ${full}`);
  }
});
