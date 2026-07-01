import test from 'node:test';
import assert from 'node:assert/strict';
import { createContact, getContacts } from '../contact.validation.js';

test('createContact: requires name + at least one phone', () => {
  const bad = createContact.body.validate({ name: 'A', phones: [] });
  assert.ok(bad.error);
  const ok = createContact.body.validate({
    name: 'Anita', phones: [{ number: '+9199' }], autoSuggestLink: true,
  });
  assert.equal(ok.error, undefined);
});

test('getContacts: q/sortBy/limit/page optional', () => {
  assert.equal(getContacts.query.validate({ q: '98', limit: 20, page: 1 }).error, undefined);
});

test('getContacts accepts favorite as boolean, rejects non-boolean', () => {
  assert.equal(getContacts.query.validate({ favorite: true }).error, undefined);
  assert.ok(getContacts.query.validate({ favorite: 'yes' }).error);
});
