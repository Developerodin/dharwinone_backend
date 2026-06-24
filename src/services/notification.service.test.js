import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isChannelAllowed } from './notification.service.js';

describe('isChannelAllowed', () => {
  it('returns true for unknown type (allow-by-default)', () => {
    assert.equal(isChannelAllowed('unknown_type', 'inApp', {}), true);
    assert.equal(isChannelAllowed('unknown_type', 'email', {}), true);
  });

  it('returns true when prefs is null or undefined', () => {
    assert.equal(isChannelAllowed('task', 'inApp', null), true);
    assert.equal(isChannelAllowed('task', 'email', undefined), true);
  });

  it('returns true when pref key is not explicitly set (opt-out default)', () => {
    assert.equal(isChannelAllowed('task', 'inApp', {}), true);
    assert.equal(isChannelAllowed('task', 'email', {}), true);
  });

  it('returns false when inApp pref is explicitly false', () => {
    assert.equal(isChannelAllowed('task', 'inApp', { taskAssignmentsInApp: false }), false);
  });

  it('returns false when email pref is explicitly false', () => {
    assert.equal(isChannelAllowed('task', 'email', { taskAssignments: false }), false);
  });

  it('channels are independent — inApp false does not block email', () => {
    assert.equal(isChannelAllowed('task', 'email', { taskAssignmentsInApp: false }), true);
  });

  it('channels are independent — email false does not block inApp', () => {
    assert.equal(isChannelAllowed('task', 'inApp', { taskAssignments: false }), true);
  });

  it('returns true when pref is explicitly true', () => {
    assert.equal(isChannelAllowed('meeting_reminder', 'inApp', { meetingRemindersInApp: true }), true);
    assert.equal(isChannelAllowed('meeting_reminder', 'email', { meetingReminders: true }), true);
  });

  it('covers all mapped notification types for inApp channel', () => {
    const types = ['leave', 'task', 'job_application', 'offer', 'meeting', 'meeting_reminder', 'certificate', 'course', 'recruiter', 'support_ticket'];
    for (const type of types) {
      assert.equal(isChannelAllowed(type, 'inApp', {}), true, `type=${type} should default to allowed`);
    }
  });
});

describe('isChannelAllowed — newly gated types', () => {
  // [type, inAppKey] for the 5 types added in this task
  const newInAppPairs = [
    ['chat_message', 'chatMessagesInApp'],
    ['placement_update', 'placementUpdatesInApp'],
    ['assignment', 'assignmentUpdatesInApp'],
    ['project', 'projectUpdatesInApp'],
    ['sop', 'sopAssignmentsInApp'],
  ];

  // Default-allow is already covered by the existing "pref key not set" test — only assert suppression here.
  for (const [type, inAppKey] of newInAppPairs) {
    it(`suppresses in-app for ${type} when ${inAppKey} is false`, () => {
      assert.equal(isChannelAllowed(type, 'inApp', { [inAppKey]: false }), false);
    });
  }

  it('suppresses email for placement_update when placementUpdates is false', () => {
    assert.equal(isChannelAllowed('placement_update', 'email', { placementUpdates: false }), false);
  });

  it('never gates account/system/general (unmapped, always allowed)', () => {
    for (const type of ['account', 'system', 'general']) {
      assert.equal(isChannelAllowed(type, 'inApp', {}), true);
      assert.equal(isChannelAllowed(type, 'email', {}), true);
    }
  });
});
