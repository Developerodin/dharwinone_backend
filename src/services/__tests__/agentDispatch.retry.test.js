import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchWithRetry } from '../agentDispatch.service.js';

const noSleep = async () => {};

test('returns the dispatch id on first success', async () => {
  let calls = 0;
  const client = {
    createDispatch: async () => {
      calls += 1;
      return { id: 'AD_1' };
    },
  };
  const r = await createDispatchWithRetry(client, {
    room: 'm1', agentName: 'a', metadata: '{}', sleepFn: noSleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.dispatchId, 'AD_1');
  assert.equal(calls, 1);
});

test('retries a transient failure and succeeds', async () => {
  let calls = 0;
  const client = {
    createDispatch: async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return { id: 'AD_2' };
    },
  };
  const r = await createDispatchWithRetry(client, {
    room: 'm1', agentName: 'a', metadata: '{}', attempts: 3, sleepFn: noSleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test('gives up after the attempt budget and reports the last error', async () => {
  const client = { createDispatch: async () => { throw new Error('no response from servers'); } };
  const r = await createDispatchWithRetry(client, {
    room: 'm1', agentName: 'a', metadata: '{}', attempts: 2, sleepFn: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.dispatchId, null);
  assert.equal(r.attempts, 2);
  assert.match(r.error, /no response from servers/);
});

test('a missing client fails without throwing', async () => {
  const r = await createDispatchWithRetry(null, {
    room: 'm1', agentName: 'a', metadata: '{}', sleepFn: noSleep,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not initialized/);
});

test('backoff grows and is bounded', async () => {
  const slept = [];
  const client = { createDispatch: async () => { throw new Error('boom'); } };
  await createDispatchWithRetry(client, {
    room: 'm1', agentName: 'a', metadata: '{}', attempts: 4,
    sleepFn: async (ms) => { slept.push(ms); },
  });
  assert.equal(slept.length, 3);
  assert.ok(slept[1] > slept[0], 'backoff must grow');
  assert.ok(Math.max(...slept) <= 8000, 'backoff must stay bounded');
});
