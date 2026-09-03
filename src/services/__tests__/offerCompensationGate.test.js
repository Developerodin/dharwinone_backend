/**
 * Compensation is only editable while the placement is live.
 *
 * Once a candidate is past the offer stage their compensation stops being a draft term and starts
 * being a record other things depend on, so changing it needs either a deliberate confirmation or
 * a different surface entirely. The gate decides which, from the placement alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  evaluateCompensationChange,
  assertCompensationChangeAllowed,
} from '../offerCompensationGate.js';

const actor = new mongoose.Types.ObjectId();
const when = new Date('2026-07-15T17:36:04.000Z');

test('an offer with no placement yet is freely editable', () => {
  // Draft / Sent / Under Negotiation — still negotiating, nothing downstream depends on it.
  assert.deepEqual(evaluateCompensationChange(null), {
    allowed: true,
    confirm: false,
    reason: 'no-placement',
    stage: null,
    actorId: null,
    at: null,
  });
});

test('a pre-boarding placement is editable but must be confirmed', () => {
  const r = evaluateCompensationChange({ status: 'Pending' });
  assert.equal(r.allowed, true);
  assert.equal(r.confirm, true);
  assert.equal(r.reason, 'live');
  assert.equal(r.stage, 'Pending');
});

test('an onboarding placement is editable but must be confirmed', () => {
  const r = evaluateCompensationChange({ status: 'Onboarding' });
  assert.equal(r.allowed, true);
  assert.equal(r.confirm, true);
  assert.equal(r.reason, 'live');
  assert.equal(r.stage, 'Onboarding');
});

test('a cancelled placement is blocked and reports who cancelled it and when', () => {
  const r = evaluateCompensationChange({
    status: 'Cancelled',
    cancelledBy: actor,
    cancelledAt: when,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.confirm, false);
  assert.equal(r.reason, 'offramp');
  assert.equal(r.stage, 'Cancelled');
  assert.equal(String(r.actorId), String(actor));
  assert.deepEqual(r.at, when);
});

test('a deferred placement is blocked and reports who deferred it', () => {
  const r = evaluateCompensationChange({
    status: 'Deferred',
    deferredBy: actor,
    deferredAt: when,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'offramp');
  assert.equal(r.stage, 'Deferred');
  assert.equal(String(r.actorId), String(actor));
  assert.deepEqual(r.at, when);
});

test('an off-ramped placement with no recorded actor still blocks', () => {
  // Older rows pre-date cancelledBy. Missing attribution must not become permission.
  const r = evaluateCompensationChange({ status: 'Cancelled' });
  assert.equal(r.allowed, false);
  assert.equal(r.actorId, null);
  assert.equal(r.at, null);
});

test('a joined placement is blocked as an employee record', () => {
  const r = evaluateCompensationChange({ status: 'Joined' });
  assert.equal(r.allowed, false);
  assert.equal(r.confirm, false);
  assert.equal(r.reason, 'joined');
  assert.equal(r.stage, 'Joined');
});

test('an unrecognised status blocks rather than falling through to allowed', () => {
  // A new PLACEMENT_STATUSES value must not silently inherit edit rights.
  const r = evaluateCompensationChange({ status: 'SomeFutureStatus' });
  assert.equal(r.allowed, false);
});

// ── assertCompensationChangeAllowed: the enforcement wrapper the services call ──────────────────

test('no compensation change means the gate never fires, whatever the stage', () => {
  // Saving the offer letter resends every field. Only an actual change is gated.
  assert.doesNotThrow(() =>
    assertCompensationChangeAllowed({ placement: { status: 'Joined' }, changing: false, ack: false })
  );
});

test('a live placement rejects an unacknowledged change', () => {
  // The confirmation dialog is client-side and therefore bypassable, and the letter form resends
  // its whole body — so the server requires the acknowledgement, not just the UI.
  assert.throws(
    () =>
      assertCompensationChangeAllowed({
        placement: { status: 'Onboarding' },
        changing: true,
        ack: false,
      }),
    (e) => e.errorCode === 'COMPENSATION_CHANGE_NEEDS_CONFIRMATION' && e.statusCode === 422
  );
});

test('a live placement accepts an acknowledged change', () => {
  assert.doesNotThrow(() =>
    assertCompensationChangeAllowed({
      placement: { status: 'Pending' },
      changing: true,
      ack: true,
    })
  );
});

test('a joined placement rejects the change even when acknowledged', () => {
  // Acknowledgement is consent, not authority. Past joining this belongs to the employee record.
  assert.throws(
    () =>
      assertCompensationChangeAllowed({
        placement: { status: 'Joined' },
        changing: true,
        ack: true,
      }),
    (e) => e.errorCode === 'COMPENSATION_LOCKED_EMPLOYEE' && e.statusCode === 422
  );
});

test('an off-ramped placement rejects the change even when acknowledged', () => {
  assert.throws(
    () =>
      assertCompensationChangeAllowed({
        placement: { status: 'Cancelled', cancelledBy: actor, cancelledAt: when },
        changing: true,
        ack: true,
      }),
    (e) => e.errorCode === 'COMPENSATION_LOCKED_OFFRAMP' && e.statusCode === 422
  );
});

test('an offer with no placement needs no acknowledgement', () => {
  assert.doesNotThrow(() =>
    assertCompensationChangeAllowed({ placement: null, changing: true, ack: false })
  );
});
