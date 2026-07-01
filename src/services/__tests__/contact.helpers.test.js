import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhones, buildContactFilter, pickSuggestedLink, assertOwner } from '../contact.helpers.js';

test('normalizePhones: digits-only + single primary (first flagged wins)', () => {
  const out = normalizePhones([
    { number: '+91 98765-43210' },
    { number: '022 1234 5678', isPrimary: true },
    { number: '(030) 111', isPrimary: true },
  ]);
  assert.equal(out[0].normalizedNumber, '919876543210');
  assert.deepEqual(out.map((p) => p.isPrimary), [false, true, false]);
  assert.equal(out[1].label, 'mobile'); // default label
});

test('normalizePhones: no flag → first is primary; empty → 400', () => {
  const out = normalizePhones([{ number: '1' }, { number: '2' }]);
  assert.deepEqual(out.map((p) => p.isPrimary), [true, false]);
  assert.throws(() => normalizePhones([]), /At least one phone/);
});

test('buildContactFilter: scopes to owner+tenant, excludes deleted, prefix phone', () => {
  const f = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: '9876' });
  assert.equal(f.tenantId, 't1'); assert.equal(f.ownerId, 'u1'); assert.equal(f.deletedAt, null);
  const phoneTerm = f.$or.find((t) => t['phones.normalizedNumber']);
  assert.deepEqual(phoneTerm, { 'phones.normalizedNumber': { $regex: '^9876' } });
});

test('buildContactFilter: short/no digit query omits phone term', () => {
  const f = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: 'ann' });
  assert.equal(f.$or.some((t) => t['phones.normalizedNumber']), false);
  const noQ = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: '' });
  assert.equal('$or' in noQ, false);
});

test('pickSuggestedLink: employees before users, else null', () => {
  assert.deepEqual(
    pickSuggestedLink({ employees: [{ _id: 'e1', name: 'Anita', personType: 'candidate' }], users: [] }),
    { type: 'candidate', id: 'e1', name: 'Anita' }
  );
  assert.deepEqual(
    pickSuggestedLink({ employees: [], users: [{ _id: 'u9', name: 'Sam' }] }),
    { type: 'user', id: 'u9', name: 'Sam' }
  );
  assert.equal(pickSuggestedLink({ employees: [], users: [] }), null);
});

test('assertOwner: 404 missing, 403 wrong owner, ok when match', () => {
  assert.throws(() => assertOwner(null, 'u1'), /not found/i);
  assert.throws(() => assertOwner({ ownerId: 'other' }, 'u1'), /allowed|forbidden|permission/i);
  assert.doesNotThrow(() => assertOwner({ ownerId: 'u1' }, 'u1'));
});
