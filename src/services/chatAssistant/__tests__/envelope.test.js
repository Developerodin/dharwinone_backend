// Tests for the structured-response envelope factory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, TONES } from '../renderers/types.js';

test('envelope() returns canonical default shape from no input', () => {
  const e = envelope();
  assert.equal(e.reply, '');
  assert.deepEqual(e.blocks, []);
  assert.deepEqual(e.meta, { kind: null, total: null, deterministic: false, tookMs: null });
});

test('envelope() preserves reply, blocks, meta when supplied', () => {
  const block = { type: 'text', md: 'hello' };
  const e = envelope({
    reply: 'hi',
    blocks: [block],
    meta: { kind: 'fetch_employees', total: 7, deterministic: true, tookMs: 42 },
  });
  assert.equal(e.reply, 'hi');
  assert.equal(e.blocks.length, 1);
  assert.equal(e.blocks[0], block);
  assert.deepEqual(e.meta, { kind: 'fetch_employees', total: 7, deterministic: true, tookMs: 42 });
});

test('envelope() coerces non-string reply to a string', () => {
  const e = envelope({ reply: 42 });
  assert.equal(e.reply, '42');
});

test('envelope() rejects non-array blocks and falls back to []', () => {
  const e = envelope({ blocks: 'not-array' });
  assert.deepEqual(e.blocks, []);
});

test('envelope() coerces undefined meta keys to canonical nulls', () => {
  const e = envelope({ meta: { kind: 'fetch_jobs' } });
  assert.equal(e.meta.kind, 'fetch_jobs');
  assert.equal(e.meta.total, null);
  assert.equal(e.meta.deterministic, false);
  assert.equal(e.meta.tookMs, null);
});

test('envelope() rejects non-numeric total + tookMs', () => {
  const e = envelope({ meta: { total: '7', tookMs: 'fast' } });
  assert.equal(e.meta.total, null);
  assert.equal(e.meta.tookMs, null);
});

test('TONES is a frozen 5-tone palette', () => {
  assert.deepEqual(Object.keys(TONES).sort(), ['danger', 'info', 'neutral', 'success', 'warn']);
  assert.equal(Object.isFrozen(TONES), true);
});
