import test from 'node:test';
import assert from 'node:assert/strict';
import { planOrphanRepair } from '../2026-06-17-fix-orphaned-cancelled-placements.js';

test('orphan whose detached offer is held by a sibling is deleted (abandoned duplicate)', () => {
  const orphans = [{ _id: 'old', _cancelledOfferRef: 'offerA' }];
  const heldOfferIds = ['offerA']; // a fresh placement already holds offerA
  const plan = planOrphanRepair(orphans, heldOfferIds);
  assert.deepEqual(plan.toDelete, ['old']);
  assert.deepEqual(plan.toRelink, []);
  assert.deepEqual(plan.unrecoverable, []);
});

test('orphan whose detached offer is free is re-linked', () => {
  const orphans = [{ _id: 'old', _cancelledOfferRef: 'offerB' }];
  const heldOfferIds = []; // no sibling created (e.g. the create failed) → offer is free
  const plan = planOrphanRepair(orphans, heldOfferIds);
  assert.deepEqual(plan.toDelete, []);
  assert.deepEqual(plan.toRelink, [{ _id: 'old', offer: 'offerB' }]);
  assert.deepEqual(plan.unrecoverable, []);
});

test('orphan with no tombstone is left for manual review', () => {
  const orphans = [{ _id: 'old', _cancelledOfferRef: null }];
  const plan = planOrphanRepair(orphans, []);
  assert.deepEqual(plan.toDelete, []);
  assert.deepEqual(plan.toRelink, []);
  assert.deepEqual(plan.unrecoverable, ['old']);
});

test('mixed batch is partitioned correctly and ObjectId-likes are stringified for comparison', () => {
  const orphans = [
    { _id: 'dup', _cancelledOfferRef: { toString: () => 'offerA' } },
    { _id: 'free', _cancelledOfferRef: 'offerC' },
    { _id: 'lost', _cancelledOfferRef: undefined },
  ];
  const heldOfferIds = [{ toString: () => 'offerA' }];
  const plan = planOrphanRepair(orphans, heldOfferIds);
  assert.deepEqual(plan.toDelete, ['dup']);
  assert.deepEqual(plan.toRelink, [{ _id: 'free', offer: 'offerC' }]);
  assert.deepEqual(plan.unrecoverable, ['lost']);
});
