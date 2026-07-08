import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeetingAccessGates } from '../livekit.service.js';

/** Base: real meeting, plain guest with the bare URL, nothing special granted. */
const base = {
  hasMeeting: true,
  approvalRequired: false,
  guestAllowed: false,
  isInvitedGuest: false,
  hostByEmail: false,
  isAdmitted: false,
  forceFullPermissions: false,
  preStartBlockPublish: false,
};

test('both toggles OFF: uninvited guest cannot enter — knocks and waits', () => {
  const g = computeMeetingAccessGates(base);
  assert.equal(g.canPublish, false);
  assert.equal(g.knocking, true);
  assert.equal(g.canSubscribe, false); // blind lobby until admitted
});

test('both toggles OFF: invited email still joins directly', () => {
  const g = computeMeetingAccessGates({ ...base, isInvitedGuest: true });
  assert.equal(g.canPublish, true);
  assert.equal(g.knocking, false);
  assert.equal(g.canSubscribe, true);
});

test('allowGuestJoin ON + approval OFF: open link, anyone joins directly', () => {
  const g = computeMeetingAccessGates({ ...base, guestAllowed: true });
  assert.equal(g.openRoom, true);
  assert.equal(g.canPublish, true);
  assert.equal(g.knocking, false);
});

test('requireApproval ON: invited guest waits (subscribe-only, no knock)', () => {
  const g = computeMeetingAccessGates({ ...base, approvalRequired: true, isInvitedGuest: true });
  assert.equal(g.canPublish, false);
  assert.equal(g.knocking, false);
  assert.equal(g.canSubscribe, true);
});

test('requireApproval ON: uninvited guest knocks blind', () => {
  const g = computeMeetingAccessGates({ ...base, approvalRequired: true });
  assert.equal(g.canPublish, false);
  assert.equal(g.knocking, true);
  assert.equal(g.canSubscribe, false);
});

test('requireApproval ON + allowGuestJoin ON: guest still waits, never direct entry', () => {
  const g = computeMeetingAccessGates({ ...base, approvalRequired: true, guestAllowed: true });
  assert.equal(g.canPublish, false);
  assert.equal(g.openRoom, false);
});

test('host bypasses all gates', () => {
  const g = computeMeetingAccessGates({ ...base, hostByEmail: true });
  assert.equal(g.canPublish, true);
  assert.equal(g.knocking, false);
});

test('admitted participant bypasses gates in every mode', () => {
  for (const approvalRequired of [true, false]) {
    const g = computeMeetingAccessGates({ ...base, approvalRequired, isAdmitted: true });
    assert.equal(g.canPublish, true);
    assert.equal(g.canSubscribe, true);
    assert.equal(g.knocking, false);
  }
});

test('forceFullPermissions (admit flow) bypasses gates', () => {
  const g = computeMeetingAccessGates({ ...base, forceFullPermissions: true, preStartBlockPublish: true });
  assert.equal(g.canPublish, true);
  assert.equal(g.canSubscribe, true);
});

test('pre-start gate blocks publish even for open rooms and invited direct entry', () => {
  const open = computeMeetingAccessGates({ ...base, guestAllowed: true, preStartBlockPublish: true });
  assert.equal(open.canPublish, false);
  const invited = computeMeetingAccessGates({ ...base, isInvitedGuest: true, preStartBlockPublish: true });
  assert.equal(invited.canPublish, false);
});

test('no meeting record: no open room, no knock', () => {
  const g = computeMeetingAccessGates({ ...base, hasMeeting: false, guestAllowed: true });
  assert.equal(g.openRoom, false);
  assert.equal(g.knocking, false);
});
