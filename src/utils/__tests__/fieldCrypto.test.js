import test from 'node:test';
import assert from 'node:assert/strict';

import { encryptField, decryptField, last4, isEncrypted } from '../fieldCrypto.js';

// fieldCrypto reads the key per call (getKey), not at module load, so setting it
// after the imports are hoisted is fine — and keeps this file free of top-level
// await, which .eslintrc.json (ecmaVersion 2020) rejects.
process.env.PAYROLL_ENCRYPTION_KEY = '0'.repeat(64);

test('round-trips a value', () => {
  const stored = encryptField('123456789012');
  assert.equal(decryptField(stored), '123456789012');
});

test('produces a v1-prefixed, four-part payload', () => {
  const parts = encryptField('abc').split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
});

test('is non-deterministic — the same input encrypts differently each time', () => {
  assert.notEqual(encryptField('same'), encryptField('same'));
});

test('rejects a tampered ciphertext rather than returning garbage', () => {
  const stored = encryptField('123456789012');
  const parts = stored.split(':');
  const flipped = Buffer.from(parts[3], 'base64');
  // Any single-byte change breaks GCM auth; increment avoids the no-bitwise rule.
  flipped[0] = (flipped[0] + 1) % 256;
  parts[3] = flipped.toString('base64');
  assert.throws(() => decryptField(parts.join(':')), /decrypt/i);
});

test('rejects an unknown version prefix', () => {
  assert.throws(() => decryptField('v9:a:b:c'), /version/i);
});

test('last4 returns the final four characters', () => {
  assert.equal(last4('123456789012'), '9012');
});

test('last4 of a short value returns the whole value', () => {
  assert.equal(last4('12'), '12');
});

test('last4 of empty or nullish is an empty string', () => {
  assert.equal(last4(''), '');
  assert.equal(last4(null), '');
});

test('isEncrypted recognises stored payloads and rejects plaintext', () => {
  assert.equal(isEncrypted(encryptField('x')), true);
  assert.equal(isEncrypted('123456789012'), false);
  assert.equal(isEncrypted(null), false);
});

test('a missing key is a loud error, not a silent passthrough', () => {
  const saved = process.env.PAYROLL_ENCRYPTION_KEY;
  delete process.env.PAYROLL_ENCRYPTION_KEY;
  assert.throws(() => encryptField('x'), /PAYROLL_ENCRYPTION_KEY/);
  process.env.PAYROLL_ENCRYPTION_KEY = saved;
});

test('a malformed key length is a loud error', () => {
  const saved = process.env.PAYROLL_ENCRYPTION_KEY;
  process.env.PAYROLL_ENCRYPTION_KEY = 'abc';
  assert.throws(() => encryptField('x'), /64 hex/);
  process.env.PAYROLL_ENCRYPTION_KEY = saved;
});
