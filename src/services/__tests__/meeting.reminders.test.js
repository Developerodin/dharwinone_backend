import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Meeting from '../../models/meeting.model.js';
import * as meetingService from '../meeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test';
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);

test.before(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await Meeting.deleteMany({ title: /^REMINDER_TEST_/ });
});
test.after(async () => {
  await Meeting.deleteMany({ title: /^REMINDER_TEST_/ });
  await mongoose.disconnect();
});

const makeMeeting = (overrides) =>
  Meeting.create({
    meetingId: `rem_${Math.random().toString(16).slice(2)}`,
    roomName: `rem_${Math.random().toString(16).slice(2)}`,
    title: 'REMINDER_TEST_base',
    scheduledAt: minutesFromNow(17),
    durationMinutes: 60,
    status: 'scheduled',
    hosts: [{ email: 'host@example.com' }],
    candidate: { email: 'cand@example.com', name: 'Cand' },
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  });

test('a meeting inside the T-15 window is marked reminderSentAt', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_window' });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.reminderSentAt instanceof Date);
});

test('a meeting outside the window is left untouched', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_early', scheduledAt: minutesFromNow(120) });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.reminderSentAt, null);
});

test('a re-run does not re-send (reminderSentAt already set)', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_idempotent' });
  await meetingService.sendUpcomingMeetingReminders();
  const first = await Meeting.findById(m._id).lean();
  await meetingService.sendUpcomingMeetingReminders();
  const second = await Meeting.findById(m._id).lean();
  assert.equal(first.reminderSentAt.toISOString(), second.reminderSentAt.toISOString());
});

test('a meeting whose lease is fresh is skipped; a stale lease is reclaimed', async () => {
  const fresh = await makeMeeting({
    title: 'REMINDER_TEST_fresh_lease',
    reminderRetry: { attempts: 1, claimedAt: new Date(Date.now() - 60000) },
  });
  const stale = await makeMeeting({
    title: 'REMINDER_TEST_stale_lease',
    reminderRetry: { attempts: 1, claimedAt: new Date(Date.now() - 30 * 60000) },
  });
  await meetingService.sendUpcomingMeetingReminders();
  const freshAfter = await Meeting.findById(fresh._id).lean();
  const staleAfter = await Meeting.findById(stale._id).lean();
  assert.equal(freshAfter.reminderSentAt, null);
  assert.ok(staleAfter.reminderSentAt instanceof Date);
});

test('a meeting with attempts already at 3 is not retried', async () => {
  const m = await makeMeeting({
    title: 'REMINDER_TEST_capped',
    reminderRetry: { attempts: 3, claimedAt: null },
  });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.reminderSentAt, null);
});
