import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../normalizeEmail.js';

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  USER@CO.COM  '), 'user@co.com');
});
test('normalizeEmail returns empty string for null', () => {
  assert.equal(normalizeEmail(null), '');
});
test('normalizeEmail returns empty string for undefined', () => {
  assert.equal(normalizeEmail(undefined), '');
});
test('normalizeEmail coerces non-string input', () => {
  assert.equal(normalizeEmail(123), '123');
});
test('normalizeEmail handles mixed case + whitespace', () => {
  assert.equal(normalizeEmail('  Jane.Doe@Example.COM\n'), 'jane.doe@example.com');
});
