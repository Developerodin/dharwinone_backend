import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInviteRegistration } from '../inviteRegistration.util.js';

describe('classifyInviteRegistration', () => {
  it('no existing user: new registration', () => {
    assert.equal(classifyInviteRegistration(null), 'new');
    assert.equal(classifyInviteRegistration(undefined), 'new');
  });

  it('pending + unverified: resume (re-send verification, never "account exists")', () => {
    assert.equal(classifyInviteRegistration({ status: 'pending', isEmailVerified: false }), 'resume');
  });

  it('verified user: conflict regardless of status', () => {
    assert.equal(classifyInviteRegistration({ status: 'pending', isEmailVerified: true }), 'conflict');
    assert.equal(classifyInviteRegistration({ status: 'active', isEmailVerified: true }), 'conflict');
  });

  it('activated/disabled/deleted user: conflict even when unverified', () => {
    assert.equal(classifyInviteRegistration({ status: 'active', isEmailVerified: false }), 'conflict');
    assert.equal(classifyInviteRegistration({ status: 'disabled', isEmailVerified: false }), 'conflict');
    assert.equal(classifyInviteRegistration({ status: 'deleted', isEmailVerified: false }), 'conflict');
  });
});
