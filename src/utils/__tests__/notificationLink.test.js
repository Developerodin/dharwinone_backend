import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotificationLink, resolveNotificationLink } from '../notificationLink.js';

describe('normalizeNotificationLink', () => {
  it('returns relative paths unchanged', () => {
    assert.equal(normalizeNotificationLink('/join/room?room=abc'), '/join/room?room=abc');
  });

  it('strips host from absolute URLs', () => {
    assert.equal(
      normalizeNotificationLink('https://app.example.com/join/room?room=abc&name=Pat'),
      '/join/room?room=abc&name=Pat'
    );
  });

  it('returns null for invalid input', () => {
    assert.equal(normalizeNotificationLink(null), null);
    assert.equal(normalizeNotificationLink('not-a-url'), null);
  });
});

describe('resolveNotificationLink meeting routes', () => {
  it('resolves legacy absolute meeting invite links', () => {
    const route = resolveNotificationLink({
      type: 'meeting',
      link: 'https://uat.example.com/join/room?room=room-123',
    });
    assert.equal(route, '/join/room?room=room-123');
  });

  it('falls back to join room from metadata.meetingId', () => {
    const route = resolveNotificationLink({
      type: 'meeting_reminder',
      metadata: { meetingId: 'room-456', meetingKind: 'interview' },
    });
    assert.equal(route, '/join/room?room=room-456');
  });

  it('routes interview conclusion to interviews list', () => {
    const route = resolveNotificationLink({
      type: 'meeting',
      metadata: { navTarget: 'interviews_list', meetingKind: 'interview' },
    });
    assert.equal(route, '/ats/interviews');
  });

  it('routes internal meetings without id to communication meetings', () => {
    const route = resolveNotificationLink({
      type: 'meeting',
      metadata: { meetingKind: 'internal' },
    });
    assert.equal(route, '/communication/meetings');
  });

  it('never returns non-existent /meeting path', () => {
    const route = resolveNotificationLink({ type: 'meeting' });
    assert.notEqual(route, '/meeting');
    assert.ok(route.startsWith('/'));
  });
});
