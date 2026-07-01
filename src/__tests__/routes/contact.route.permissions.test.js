import test from 'node:test';
import assert from 'node:assert/strict';
import { getGrantingPermissions } from '../../config/permissions.js';

test('contacts.* aliases resolve (domain + api forms)', () => {
  assert.ok(getGrantingPermissions('contacts.view').includes('communication.contacts:view,create,edit,delete'));
  assert.ok(getGrantingPermissions('contacts.create').includes('contacts.create'));
  assert.ok(getGrantingPermissions('contacts.edit').includes('communication.contacts:edit'));
  assert.ok(getGrantingPermissions('contacts.delete').includes('contacts.delete'));
});
