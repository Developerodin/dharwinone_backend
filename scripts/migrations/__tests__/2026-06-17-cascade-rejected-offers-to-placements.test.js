import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRejectedOfferReconcile } from '../2026-06-17-cascade-rejected-offers-to-placements.js';

test('cancels active placements under a rejected offer (Pending/Onboarding/Deferred)', () => {
  const plan = planRejectedOfferReconcile([
    { _id: 'a', offer: 'o1', status: 'Pending' },
    { _id: 'b', offer: 'o2', status: 'Onboarding' },
    { _id: 'c', offer: 'o3', status: 'Deferred' },
  ]);
  assert.deepEqual(plan.toCancel, ['a', 'b', 'c']);
  assert.equal(plan.skippedJoined.length, 0);
  assert.equal(plan.skippedCancelled.length, 0);
});

test('skips Joined placements (hire already started)', () => {
  const plan = planRejectedOfferReconcile([{ _id: 'j', offer: 'o1', status: 'Joined' }]);
  assert.deepEqual(plan.toCancel, []);
  assert.deepEqual(plan.skippedJoined, ['j']);
});

test('skips already-Cancelled placements (idempotent)', () => {
  const plan = planRejectedOfferReconcile([{ _id: 'x', offer: 'o1', status: 'Cancelled' }]);
  assert.deepEqual(plan.toCancel, []);
  assert.deepEqual(plan.skippedCancelled, ['x']);
});

test('mixed batch partitions correctly', () => {
  const plan = planRejectedOfferReconcile([
    { _id: 'a', offer: 'o1', status: 'Pending' },
    { _id: 'j', offer: 'o2', status: 'Joined' },
    { _id: 'x', offer: 'o3', status: 'Cancelled' },
    { _id: 'd', offer: 'o4', status: 'Deferred' },
  ]);
  assert.deepEqual(plan.toCancel, ['a', 'd']);
  assert.deepEqual(plan.skippedJoined, ['j']);
  assert.deepEqual(plan.skippedCancelled, ['x']);
});

test('empty / nullish input is safe', () => {
  assert.deepEqual(planRejectedOfferReconcile([]).toCancel, []);
  assert.deepEqual(planRejectedOfferReconcile(undefined).toCancel, []);
});
