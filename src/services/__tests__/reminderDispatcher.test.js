import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReminder, classifyError, isRetryableCategory } from '../reminderDispatcher.js';

test('classifyError maps known shapes', () => {
  assert.equal(classifyError(Object.assign(new Error('x'), { isTimeout: true })), 'timeout');
  assert.equal(classifyError(Object.assign(new Error('x'), { isInvalidRecipient: true })), 'invalid_recipient');
  assert.equal(classifyError(Object.assign(new Error('x'), { isTemplateError: true })), 'template_failure');
  assert.equal(classifyError(Object.assign(new Error('x'), { responseCode: 503 })), 'provider_failure');
  assert.equal(classifyError(new Error('weird')), 'unknown');
});

test('isRetryableCategory: transient categories retry, permanent do not', () => {
  assert.equal(isRetryableCategory('timeout'), true);
  assert.equal(isRetryableCategory('provider_failure'), true);
  assert.equal(isRetryableCategory('unknown'), true);
  assert.equal(isRetryableCategory('invalid_recipient'), false);
  assert.equal(isRetryableCategory('template_failure'), false);
});

test('ok=true when at least one recipient delivers; failures do not abort the pool', async () => {
  const seen = [];
  const res = await dispatchReminder({
    kind: 'interviewT15',
    recipients: ['a', 'b', 'c'],
    deliver: async (r) => {
      seen.push(r);
      if (r === 'b') throw Object.assign(new Error('bad addr'), { isInvalidRecipient: true });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 3);
});

test('ok=false with category when nothing delivers', async () => {
  const res = await dispatchReminder({
    kind: 'conclusion',
    recipients: ['a'],
    deliver: async () => {
      throw Object.assign(new Error('bad addr'), { isInvalidRecipient: true });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, 'invalid_recipient');
});

test('ok=true for an empty recipient list', async () => {
  const res = await dispatchReminder({ kind: 'interviewT15', recipients: [], deliver: async () => {} });
  assert.equal(res.ok, true);
});

test('a hung deliver is timed out and classified as timeout', async () => {
  process.env.REMINDER_TIMEOUT_MS = '50';
  const res = await dispatchReminder({
    kind: 'interviewT15',
    recipients: ['a'],
    deliver: () => new Promise(() => {}),
  });
  delete process.env.REMINDER_TIMEOUT_MS;
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, 'timeout');
});

const r = (n) => Array.from({ length: n }, (_, i) => ({ email: `u${i}@example.com` }));

test('a deliberate skip is counted separately from a delivery', async () => {
  const out = await dispatchReminder({
    kind: 'interviewT15',
    recipients: r(3),
    deliver: async (x) => x.email === 'u0@example.com',
  });
  assert.equal(out.delivered, 1);
  assert.equal(out.skipped, 2);
  assert.equal(out.ok, true);
});

test('everyone opting out is a success, not a retry', async () => {
  const out = await dispatchReminder({
    kind: 'interviewT15',
    recipients: r(2),
    deliver: async () => false,
  });
  assert.equal(out.delivered, 0);
  assert.equal(out.skipped, 2);
  assert.equal(out.ok, true);
});

test('an empty recipient list reports zero of both', async () => {
  const out = await dispatchReminder({ kind: 'interviewT15', recipients: [], deliver: async () => true });
  assert.deepEqual(out, { ok: true, delivered: 0, skipped: 0 });
});

test('a total failure is not ok and carries the first error', async () => {
  const out = await dispatchReminder({
    kind: 'interviewT15',
    recipients: r(2),
    deliver: async () => {
      throw Object.assign(new Error('smtp exploded'), { responseCode: 550 });
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.delivered, 0);
  assert.equal(out.skipped, 0);
  assert.equal(out.error, 'smtp exploded');
});

test('a partial failure still succeeds and reports what landed', async () => {
  let first = true;
  const out = await dispatchReminder({
    kind: 'interviewT15',
    recipients: r(2),
    deliver: async () => {
      if (first) {
        first = false;
        throw new Error('nope');
      }
      return true;
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.delivered, 1);
});

test('a falsy-but-not-false return still counts as delivered, not skipped', async () => {
  // Only a literal `false` means "deliberately suppressed". A deliver that falls off the
  // end returning undefined (or any other non-false falsy value) must still book a delivery.
  const out = await dispatchReminder({
    kind: 'interviewT15',
    recipients: r(2),
    deliver: async () => {},
  });
  assert.equal(out.delivered, 2);
  assert.equal(out.skipped, 0);
});
