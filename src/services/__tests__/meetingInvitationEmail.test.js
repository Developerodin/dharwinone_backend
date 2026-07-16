import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingInvitationEmail } from '../email.service.js';

test('buildMeetingInvitationEmail includes join link for Video meetings', () => {
  const joinUrl =
    'https://app.example.com/join/room?room=meeting_abc&name=Akbar&email=akbar.mohammed%40dharwinbusinesssolutions.com';
  const out = buildMeetingInvitationEmail({
    title: 'Weekly Sprint Meeting - Trainer Phase 1',
    scheduledAt: new Date('2026-07-20T10:00:00.000Z'),
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
    inviteeName: 'Akbar',
    hostName: 'Trainer',
    interviewType: 'Video',
    jobPosition: '',
    description: 'Phase 1 sync',
    publicMeetingUrl: joinUrl,
  });

  assert.match(out.subject, /Weekly Sprint Meeting/);
  assert.match(out.text, /Join meeting: https:\/\/app\.example\.com\/join\/room/);
  assert.match(out.text, /Join link: https:\/\/app\.example\.com\/join\/room/);
  assert.match(out.html, /Join meeting/);
  assert.match(out.html, /https:\/\/app\.example\.com\/join\/room/);
  assert.equal(out.joinUrl, joinUrl);
  assert.equal(out.isVideoMeeting, true);
});

test('buildMeetingInvitationEmail omits join button when Video meeting has no URL', () => {
  const out = buildMeetingInvitationEmail({
    title: 'Broken invite',
    scheduledAt: new Date('2026-07-20T10:00:00.000Z'),
    timezone: 'UTC',
    durationMinutes: 30,
    interviewType: 'Video',
    publicMeetingUrl: '',
  });

  assert.doesNotMatch(out.text, /Join meeting:/);
  assert.doesNotMatch(out.html, /Join meeting/);
  assert.doesNotMatch(out.text, /Join link:/);
  assert.equal(out.joinUrl, '');
});

test('buildMeetingInvitationEmail omits join link for In-Person meetings', () => {
  const out = buildMeetingInvitationEmail({
    title: 'Standup',
    scheduledAt: new Date('2026-07-20T10:00:00.000Z'),
    timezone: 'UTC',
    interviewType: 'In-Person',
    publicMeetingUrl: 'https://app.example.com/join/room?room=x',
  });

  assert.doesNotMatch(out.text, /Join meeting:/);
  assert.doesNotMatch(out.text, /Join link:/);
  assert.equal(out.isVideoMeeting, false);
});

const joinUrl = 'https://app.example.com/join/room?room=meeting_abc';

const baseVideoPayload = {
  title: 'Policy test meeting',
  scheduledAt: new Date('2026-07-20T10:00:00.000Z'),
  timezone: 'UTC',
  durationMinutes: 60,
  interviewType: 'Video',
  publicMeetingUrl: joinUrl,
};

test('buildMeetingInvitationEmail joining tips: requireApproval ON + allowGuestJoin OFF', () => {
  const out = buildMeetingInvitationEmail({
    ...baseVideoPayload,
    requireApproval: true,
    allowGuestJoin: false,
  });

  assert.match(out.text, /waiting room until the host admits you/i);
  assert.match(out.text, /ask for permission/i);
  assert.doesNotMatch(out.text, /open room/i);
});

test('buildMeetingInvitationEmail joining tips: requireApproval ON + allowGuestJoin ON', () => {
  const out = buildMeetingInvitationEmail({
    ...baseVideoPayload,
    requireApproval: true,
    allowGuestJoin: true,
  });

  assert.match(out.text, /waiting room until the host admits them/i);
  assert.doesNotMatch(out.text, /open room/i);
});

test('buildMeetingInvitationEmail joining tips: requireApproval OFF + allowGuestJoin ON', () => {
  const out = buildMeetingInvitationEmail({
    ...baseVideoPayload,
    requireApproval: false,
    allowGuestJoin: true,
  });

  assert.match(out.text, /open room — anyone with the join link can enter directly/i);
});

test('buildMeetingInvitationEmail joining tips: requireApproval OFF + allowGuestJoin OFF', () => {
  const out = buildMeetingInvitationEmail({
    ...baseVideoPayload,
    requireApproval: false,
    allowGuestJoin: false,
  });

  assert.match(out.text, /invite-only/i);
  assert.match(out.text, /request access/i);
  assert.doesNotMatch(out.text, /open room/i);
});
