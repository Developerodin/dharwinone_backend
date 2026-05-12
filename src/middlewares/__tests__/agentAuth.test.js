import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { signAgentRequest } from '../agentAuth.js';

test('signAgentRequest produces deterministic SHA-256 hex signature', () => {
  const sig1 = signAgentRequest({ token: 'abc', timestamp: '1700000000000', body: '{"x":1}' });
  const sig2 = signAgentRequest({ token: 'abc', timestamp: '1700000000000', body: '{"x":1}' });
  assert.equal(sig1, sig2);
  assert.match(sig1, /^[a-f0-9]{64}$/);
});

test('signAgentRequest differs across tokens', () => {
  const a = signAgentRequest({ token: 'abc', timestamp: '1', body: 'x' });
  const b = signAgentRequest({ token: 'xyz', timestamp: '1', body: 'x' });
  assert.notEqual(a, b);
});

test('signAgentRequest matches a hand-computed HMAC', () => {
  const sig = signAgentRequest({ token: 'k', timestamp: 'ts', body: 'body' });
  const expected = crypto.createHmac('sha256', 'k').update('ts.body').digest('hex');
  assert.equal(sig, expected);
});
