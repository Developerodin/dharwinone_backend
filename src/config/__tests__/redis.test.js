import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redisConnection, redisPartialConnection, closeRedisConnections } from '../redis.js';

test('redisConnection returns a config object with maxRetriesPerRequest=null (BullMQ requirement)', () => {
  const c = redisConnection();
  assert.equal(c.maxRetriesPerRequest, null);
  assert.ok(c.host || c.url, 'connection should have host or url');
  assert.equal(c.db, 1);
});

test('redisPartialConnection uses a different db than queue', () => {
  const q = redisConnection();
  const p = redisPartialConnection();
  assert.notEqual(q.db, p.db);
  assert.equal(p.db, 2);
});

test('closeRedisConnections is callable without throwing', async () => {
  await closeRedisConnections();
});
