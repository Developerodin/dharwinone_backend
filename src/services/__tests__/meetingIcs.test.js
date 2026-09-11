import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcsEvent, buildMeetingIcs } from '../email.service.js';

/**
 * Meeting invitations carried no calendar attachment at all: `buildIcsEvent` existed but had
 * no caller anywhere in src/, so an invitation never landed in the recipient's Outlook or
 * Google calendar. These cover the attachment now wired into every invitation send.
 */

const MEETING = {
  id: 'meeting_abc',
  title: 'Weekly Sprint Meeting',
  description: 'Phase 1 sync',
  scheduledAt: new Date('2026-09-11T14:30:00.000Z'),
  durationMinutes: 30,
};
const JOIN_URL = 'https://app.example.com/join/room?room=meeting_abc';
const ATTENDEE = 'invitee@example.com';

/**
 * Reverse RFC 5545 line folding — a parser strips CRLF followed by one space/tab. Assertions
 * on a property's value run against the unfolded text, because where a long line breaks is a
 * wire-format detail, not part of the value.
 */
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');

/** Every physical line, as the octet counts that RFC 5545 actually caps. */
const lineOctets = (ics) => ics.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8'));

test('buildMeetingIcs emits a VEVENT with UTC start/end derived from the duration', () => {
  const ics = buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE);
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR$/);
  assert.match(ics, /DTSTART:20260911T143000Z/);
  // 14:30 + 30 min
  assert.match(ics, /DTEND:20260911T150000Z/);
  assert.match(ics, /SUMMARY:Weekly Sprint Meeting/);
});

test('buildMeetingIcs lists the recipient as an ATTENDEE', () => {
  // Outlook treats METHOD:REQUEST with no ATTENDEE as malformed and will not offer
  // Accept/Decline, which is the whole point of sending a calendar invite.
  const ics = unfold(buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE));
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, new RegExp(`ATTENDEE;[^\\r\\n]*mailto:${ATTENDEE}`));
  assert.match(ics, /ORGANIZER:mailto:\S+@\S+/);
});

test('buildMeetingIcs derives a stable UID from the meeting id', () => {
  // A stable UID makes a re-send (resend invitations, reschedule) update the existing
  // calendar entry instead of adding a duplicate one.
  const a = buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE);
  const b = buildMeetingIcs(MEETING, JOIN_URL, 'someone.else@example.com');
  const uidOf = (s) => s.match(/UID:(.+)/)[1].trim();
  assert.equal(uidOf(a), uidOf(b));
  assert.match(uidOf(a), /meeting_abc/);
});

test('buildMeetingIcs puts the join link in both LOCATION and DESCRIPTION', () => {
  const ics = unfold(buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE));
  assert.match(ics, new RegExp(`LOCATION:${JOIN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(ics, /DESCRIPTION:.*Join:/);
});

test('no physical line exceeds the RFC 5545 limit of 75 octets', () => {
  // A long unfolded line invites anything in the mail path that re-wraps it to insert a CRLF
  // without the continuation space, which corrupts the calendar body. LOCATION and
  // DESCRIPTION carry the join URL, so they are the lines that would overflow.
  const ics = buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE);
  const tooLong = lineOctets(ics).filter((n) => n > 75);
  assert.deepEqual(tooLong, [], `these lines exceed 75 octets: ${tooLong.join(', ')}`);
});

test('folding is reversible — unfolding restores the original property values', () => {
  const longTitle = 'Quarterly planning and roadmap review with the extended platform team';
  const longUrl = `${JOIN_URL}&name=Some%20Long%20Invitee%20Name&email=invitee%40example.com`;
  const ics = buildMeetingIcs({ ...MEETING, title: longTitle }, longUrl, ATTENDEE);

  assert.ok(lineOctets(ics).every((n) => n <= 75), 'expected every line within 75 octets');
  const restored = unfold(ics);
  assert.match(restored, new RegExp(`SUMMARY:${longTitle}`));
  assert.match(restored, new RegExp(`LOCATION:${longUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('folding never splits a multi-byte UTF-8 character', () => {
  // Folding counts octets, so a naive split can land inside a multi-byte sequence and produce
  // a replacement character. Padding pushes the accented characters across the 75-octet mark.
  const title = `Réunion trimestrielle — planification ${'é'.repeat(40)}`;
  const ics = buildIcsEvent({
    uid: 'u1@dharwin',
    title,
    startAt: new Date('2026-09-11T14:30:00.000Z'),
    durationMinutes: 60,
  });
  assert.ok(lineOctets(ics).every((n) => n <= 75), 'expected every line within 75 octets');
  assert.ok(!unfold(ics).includes('�'), 'a fold corrupted a multi-byte character');
  assert.match(unfold(ics), new RegExp(`SUMMARY:${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('buildMeetingIcs returns empty string when the meeting has no id or start', () => {
  // Callers put the result straight into the email payload; an empty string means "no
  // attachment" rather than a malformed .ics that would make Outlook reject the message.
  assert.equal(buildMeetingIcs({ title: 'x' }, JOIN_URL, ATTENDEE), '');
  assert.equal(buildMeetingIcs({ id: 'x' }, JOIN_URL, ATTENDEE), '');
  assert.equal(buildMeetingIcs(null, JOIN_URL, ATTENDEE), '');
});

test('buildIcsEvent escapes characters that would break the ICS line format', () => {
  const ics = buildIcsEvent({
    uid: 'u1@dharwin',
    title: 'Review; Q3, final',
    description: 'line one\nline two',
    startAt: new Date('2026-09-11T14:30:00.000Z'),
    durationMinutes: 60,
  });
  assert.match(ics, /SUMMARY:Review\\; Q3\\, final/);
  assert.match(ics, /DESCRIPTION:line one\\nline two/);
  assert.ok(!/DESCRIPTION:line one\r?\nline two/.test(ics), 'a raw newline would end the line');
});

test('buildIcsEvent still supports a recurring RRULE for callers that want one', () => {
  const ics = buildIcsEvent({
    uid: 'series-1@dharwin',
    title: 'Daily standup',
    startAt: new Date('2026-09-11T14:30:00.000Z'),
    rrule: 'FREQ=DAILY;INTERVAL=1',
  });
  assert.match(ics, /RRULE:FREQ=DAILY;INTERVAL=1/);
});

/**
 * A reschedule re-sends the same UID. Outlook and Google only replace the entry they already
 * hold when SEQUENCE rises, so a same-SEQUENCE resend would leave attendees on the old slot.
 */
test('buildMeetingIcs raises SEQUENCE with the meeting revision', () => {
  const first = buildMeetingIcs({ ...MEETING, updatedAt: new Date('2026-09-11T10:00:00.000Z') }, JOIN_URL, ATTENDEE);
  const moved = buildMeetingIcs({ ...MEETING, updatedAt: new Date('2026-09-11T11:00:00.000Z') }, JOIN_URL, ATTENDEE);
  const seq = (ics) => Number(unfold(ics).match(/SEQUENCE:(\d+)/)[1]);
  // Same event, so the calendar updates in place rather than duplicating.
  assert.match(first, /UID:meeting-meeting_abc@dharwin/);
  assert.match(moved, /UID:meeting-meeting_abc@dharwin/);
  assert.ok(seq(moved) > seq(first), 'a later revision must outrank the copy already delivered');
  // Two sends of one revision (invite, then resend) must agree, or they race.
  assert.equal(seq(buildMeetingIcs({ ...MEETING, updatedAt: new Date('2026-09-11T11:00:00.000Z') }, JOIN_URL, ATTENDEE)), seq(moved));
});

test('buildMeetingIcs falls back to SEQUENCE 0 when the doc carries no updatedAt', () => {
  assert.match(buildMeetingIcs(MEETING, JOIN_URL, ATTENDEE), /SEQUENCE:0/);
});
