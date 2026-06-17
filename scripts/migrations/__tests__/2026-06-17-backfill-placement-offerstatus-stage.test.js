import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPlacementBackfill } from '../2026-06-17-backfill-placement-offerstatus-stage.js';

const D1 = new Date('2026-06-01T00:00:00.000Z');
const D2 = new Date('2026-06-10T00:00:00.000Z');

test('mirrors offerStatus from the linked offer', () => {
  const { updates } = planPlacementBackfill(
    [{ _id: 'a', offer: 'o1', status: 'Pending', updatedAt: D1 }],
    { o1: 'Accepted' }
  );
  assert.equal(updates[0]._id, 'a');
  assert.equal(updates[0].set.offerStatus, 'Accepted');
});

test('rejected offer mirrors to offerStatus=Rejected', () => {
  const { updates } = planPlacementBackfill(
    [{ _id: 'a', offer: 'o1', status: 'Cancelled', updatedAt: D1 }],
    { o1: 'Rejected' }
  );
  assert.equal(updates[0].set.offerStatus, 'Rejected');
});

test('Onboarding/Joined infer enteredOnboardingAt', () => {
  const { updates } = planPlacementBackfill(
    [
      { _id: 'on', offer: 'o1', status: 'Onboarding', updatedAt: D1 },
      { _id: 'jn', offer: 'o2', status: 'Joined', joinedAt: D2, updatedAt: D1 },
    ],
    { o1: 'Accepted', o2: 'Accepted' }
  );
  assert.equal(updates.find((u) => u._id === 'on').set.enteredOnboardingAt, D1);
  assert.equal(updates.find((u) => u._id === 'jn').set.enteredOnboardingAt, D2); // joinedAt wins
});

test('off-ramp WITH onboarding footprint infers entered; WITHOUT is flagged ambiguous', () => {
  const { updates, ambiguousOfframp } = planPlacementBackfill(
    [
      { _id: 'withTasks', offer: 'o1', status: 'Cancelled', onboardingTasksCount: 2, updatedAt: D1 },
      { _id: 'bare', offer: 'o2', status: 'Deferred', updatedAt: D1 },
    ],
    { o1: 'Accepted', o2: 'Accepted' }
  );
  assert.equal(updates.find((u) => u._id === 'withTasks').set.enteredOnboardingAt, D1);
  // bare off-ramp: offerStatus still set, but no enteredOnboardingAt, and id flagged ambiguous.
  const bare = updates.find((u) => u._id === 'bare');
  assert.equal(bare.set.enteredOnboardingAt, undefined);
  assert.deepEqual(ambiguousOfframp, ['bare']);
});

test('Pending with no footprint → offerStatus only, enteredOnboardingAt stays null', () => {
  const { updates, ambiguousOfframp } = planPlacementBackfill(
    [{ _id: 'p', offer: 'o1', status: 'Pending', updatedAt: D1 }],
    { o1: 'Accepted' }
  );
  assert.deepEqual(updates[0].set, { offerStatus: 'Accepted' });
  assert.equal(ambiguousOfframp.length, 0);
});

test('already-set enteredOnboardingAt is not overwritten', () => {
  const { updates } = planPlacementBackfill(
    [{ _id: 'p', offer: 'o1', status: 'Joined', offerStatus: 'Accepted', enteredOnboardingAt: D1, joinedAt: D2, updatedAt: D2 }],
    { o1: 'Accepted' }
  );
  assert.equal(updates.length, 0); // offerStatus already correct + enteredOnboardingAt already set
});

test('orphan placement (no offer) is recorded, not updated for offerStatus', () => {
  const { updates, orphans } = planPlacementBackfill(
    [{ _id: 'orph', offer: null, status: 'Pending', updatedAt: D1 }],
    {}
  );
  assert.deepEqual(orphans, ['orph']);
  assert.equal(updates.length, 0);
});

test('no redundant write when offerStatus already correct', () => {
  const { updates } = planPlacementBackfill(
    [{ _id: 'p', offer: 'o1', status: 'Pending', offerStatus: 'Accepted', updatedAt: D1 }],
    { o1: 'Accepted' }
  );
  assert.equal(updates.length, 0);
});
