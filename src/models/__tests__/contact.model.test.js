import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Contact from '../contact.model.js';

const oid = () => new mongoose.Types.ObjectId();

test('requires tenantId, ownerId, name', () => {
  const err = new Contact({}).validateSync();
  assert.ok(err.errors.tenantId && err.errors.ownerId && err.errors.name);
});

test('valid contact passes; source enum enforced', () => {
  const ok = new Contact({
    tenantId: oid(), ownerId: oid(), name: 'Anita',
    phones: [{ label: 'work', number: '+91 98765 43210', normalizedNumber: '919876543210', isPrimary: true }],
    source: 'from_call',
  }).validateSync();
  assert.equal(ok, undefined);
  const bad = new Contact({
    tenantId: oid(), ownerId: oid(), name: 'X', source: 'nope',
  }).validateSync();
  assert.ok(bad.errors.source);
});
