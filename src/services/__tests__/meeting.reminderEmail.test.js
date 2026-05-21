import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Meeting from '../../models/meeting.model.js';
import EmailLog from '../../models/emailLog.model.js';
import * as emailService from '../email.service.js';
import * as meetingService from '../meeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test';
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);

test.before(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await Meeting.deleteMany({ title: /^REMINDER_EMAIL_TEST_/ });
});

test.after(async () => {
  await Meeting.deleteMany({ title: /^REMINDER_EMAIL_TEST_/ });
  await mongoose.disconnect();
});

test('buildMeetingReminderEmail includes timezone-aware schedule text', () => {
  const out = emailService.buildMeetingReminderEmail({
    title: 'Backend Interview',
    scheduledAt: new Date('2026-05-20T11:00:00.000Z'),
    timezone: 'UTC',
    publicMeetingUrl: 'https://app.example.com/join/abc',
    inviteeName: 'Alex',
  });
  assert.match(out.subject, /Backend Interview/);
  assert.match(out.text, /Alex/);
  assert.match(out.text, /https:\/\/app\.example\.com\/join\/abc/);
});

test('sendUpcomingMeetingReminders emails guest invitees without user accounts', async () => {
  const guestEmail = `candidate-guest-${Date.now()}@example.com`;
  const hostEmail = `host-guest-${Date.now()}@example.com`;

  const m = await Meeting.create({
    meetingId: `rem_guest_${Date.now()}`,
    roomName: `rem_guest_${Date.now()}`,
    title: 'REMINDER_EMAIL_TEST_guest',
    scheduledAt: minutesFromNow(17),
    durationMinutes: 60,
    status: 'scheduled',
    timezone: 'UTC',
    hosts: [{ email: hostEmail, name: 'Host' }],
    candidate: { email: guestEmail, name: 'Candidate' },
    createdBy: new mongoose.Types.ObjectId(),
  });

  await meetingService.sendUpcomingMeetingReminders();

  const guestLogs = await EmailLog.find({ to: guestEmail, templateName: 'meeting_reminder' }).lean();
  const hostLogs = await EmailLog.find({ to: hostEmail, templateName: 'meeting_reminder' }).lean();
  assert.ok(guestLogs.length >= 1, 'expected guest reminder email log');
  assert.ok(hostLogs.length >= 1, 'expected host reminder email log');

  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.reminderSentAt instanceof Date);
});
