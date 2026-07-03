import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhones,
  buildContactFilter,
  pickSuggestedLink,
  assertOwner,
  callPhoneKeys,
  buildCallPhoneFilter,
} from '../contact.helpers.js';

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
  const f = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: '987654' });
  assert.equal(f.tenantId, 't1'); assert.equal(f.ownerId, 'u1'); assert.equal(f.deletedAt, null);
  const phoneTerm = f.$or.find((t) => t['phones.normalizedNumber']);
  assert.deepEqual(phoneTerm, { 'phones.normalizedNumber': { $regex: '^987654' } });
});

test('buildContactFilter: short/no digit query omits phone term', () => {
  const f = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: 'ann' });
  assert.equal(f.$or.some((t) => t['phones.normalizedNumber']), false);
  const short = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: '9876' }); // <6 digits: omitted
  assert.equal(short.$or.some((t) => t['phones.normalizedNumber']), false);
  const noQ = buildContactFilter({ tenantId: 't1', ownerId: 'u1', q: '' });
  assert.equal('$or' in noQ, false);
});

test('buildContactFilter adds favorite:true only when favorite===true', () => {
  const base = { tenantId: 't1', ownerId: 'o1' };
  assert.equal(buildContactFilter({ ...base, favorite: true }).favorite, true);
  assert.equal('favorite' in buildContactFilter({ ...base }), false);
  assert.equal('favorite' in buildContactFilter({ ...base, favorite: false }), false);
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

test('callPhoneKeys: trailing 10 digits, dedups, skips <7-digit numbers', () => {
  const keys = callPhoneKeys([
    { number: '+91 98765-43210' },        // 919876543210 -> last10 9876543210
    { number: '098765 43210' },           // 09876543210  -> last10 9876543210 (dup)
    { normalizedNumber: '2212345678' },   // 2212345678
    { number: '12345' },                  // 5 digits -> skipped
  ]);
  assert.deepEqual([...keys].sort(), ['2212345678', '9876543210']);
});

test('callPhoneKeys: empty / all-short input -> []', () => {
  assert.deepEqual(callPhoneKeys([]), []);
  assert.deepEqual(callPhoneKeys([{ number: '123' }]), []);
  assert.deepEqual(callPhoneKeys(undefined), []);
});

test('buildCallPhoneFilter: builds $or over 4 fields with anchored digit regex', () => {
  const f = buildCallPhoneFilter(['9876543210']);
  assert.equal(f.$or.length, 4);
  const fields = f.$or.map((c) => Object.keys(c)[0]).sort();
  assert.deepEqual(fields, ['fromPhoneNumber', 'phone', 'recipientPhoneNumber', 'toPhoneNumber']);
  const re = f.$or.find((c) => c.toPhoneNumber).toPhoneNumber;
  assert.ok(re instanceof RegExp && re.source === '9876543210$');
  assert.ok(re.test('919876543210'));    // suffix match
  assert.ok(!re.test('98765432109'));    // not a suffix
});

test('buildCallPhoneFilter: no keys -> null', () => {
  assert.equal(buildCallPhoneFilter([]), null);
});

test('buildCallPhoneFilter: distinct 10-digit keys do not collide', () => {
  const f = buildCallPhoneFilter(['9876543210', '9000000210']);
  assert.equal(f.$or.length, 8); // 4 fields x 2 keys
});
