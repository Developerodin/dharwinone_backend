import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildQOrClause } from '../activityLog.service.js';

test('buildQOrClause matches the three technical fields', () => {
  const or = buildQOrClause('role.create', []);
  assert.equal(or.length, 3);
  assert.ok(or.some((c) => c.action instanceof RegExp));
  assert.ok(or.some((c) => c.entityType instanceof RegExp));
  assert.ok(or.some((c) => c.entityId instanceof RegExp));
});

test('buildQOrClause adds ip + clientIp clauses for an ip-like query', () => {
  const or = buildQOrClause('192.168', []);
  assert.ok(or.some((c) => c.ip));
  assert.ok(or.some((c) => c.clientIp));
});

test('buildQOrClause omits ip clauses for normal text', () => {
  const or = buildQOrClause('priya', []);
  assert.ok(!or.some((c) => c.ip));
  assert.ok(!or.some((c) => c.clientIp));
});

test('buildQOrClause appends actor $in when ids are provided', () => {
  const id = new mongoose.Types.ObjectId();
  const or = buildQOrClause('priya', [id]);
  const actorClause = or.find((c) => c.actor);
  assert.ok(actorClause, 'expected an actor clause');
  assert.deepEqual(actorClause.actor.$in, [id]);
});

test('buildQOrClause omits the actor clause when no ids are provided', () => {
  const or = buildQOrClause('priya', []);
  assert.ok(!or.some((c) => c.actor));
});
