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
