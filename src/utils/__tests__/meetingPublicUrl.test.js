import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMeetingJoinQuery,
  getInAppMeetingLink,
  getPublicMeetingUrl,
} from '../meetingPublicUrl.js';

test('valid meetingId builds a room query', () => {
  assert.equal(buildMeetingJoinQuery('meeting_abc'), 'room=meeting_abc');
  assert.equal(getInAppMeetingLink('meeting_abc'), '/join/room?room=meeting_abc');
  const url = getPublicMeetingUrl('meeting_abc');
  assert.match(url, /^https?:\/\/.+\/join\/room\?room=meeting_abc$/);
});

test('missing meetingId yields no link, never room=undefined', () => {
  for (const bad of [undefined, null, '']) {
    assert.equal(buildMeetingJoinQuery(bad), '');
    assert.equal(getInAppMeetingLink(bad), '');
    assert.equal(getPublicMeetingUrl(bad), '');
  }
});

test('personalized join URL includes invite name and email', () => {
  const url = getPublicMeetingUrl('room_xyz', { name: 'Akbar', email: 'akbar.mohammed@dharwinbusinesssolutions.com' });
  assert.match(url, /room=room_xyz/);
  assert.match(url, /name=Akbar/);
  assert.match(url, /email=akbar\.mohammed%40dharwinbusinesssolutions\.com/);
});
