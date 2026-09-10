import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import Meeting from '../../models/meeting.model.js';
import User from '../../models/user.model.js';
import * as meetingService from '../meeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_reminders';
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);

const HOST_EMAIL = 'host@example.com';
const CAND_EMAIL = 'cand@example.com';

const optedOutPrefs = {
  meetingReminders: false,
  meetingRemindersInApp: false,
};

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share one ' +
      'MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL to a dedicated database.'
  );
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await Meeting.deleteMany({ title: /^REMINDER_TEST_/ });
  await User.deleteMany({ email: { $in: [HOST_EMAIL, CAND_EMAIL] } });
  await User.create([
    {
      name: 'Host',
      email: HOST_EMAIL,
      password: 'Password1',
      role: 'user',
      notificationPreferences: optedOutPrefs,
    },
    {
      name: 'Cand',
      email: CAND_EMAIL,
      password: 'Password1',
      role: 'user',
      notificationPreferences: optedOutPrefs,
    },
  ]);
});

test.after(async () => {
  await Meeting.deleteMany({ title: /^REMINDER_TEST_/ });
  await User.deleteMany({ email: { $in: [HOST_EMAIL, CAND_EMAIL] } });
  await mongoose.disconnect();
});

/** An interview 10 minutes out whose reminder came due 30 seconds ago. */
const makeMeeting = (overrides) =>
  Meeting.create({
    meetingId: `rem_${Math.random().toString(16).slice(2)}`,
    roomName: `rem_${Math.random().toString(16).slice(2)}`,
    title: 'REMINDER_TEST_base',
    scheduledAt: minutesFromNow(10),
    remindAt: minutesFromNow(-0.5),
    durationMinutes: 60,
    status: 'scheduled',
    hosts: [{ email: HOST_EMAIL }],
    candidate: { email: CAND_EMAIL, name: 'Cand' },
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  });

test('a meeting whose remindAt has come due is marked reminderSentAt', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_window' });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.reminderSentAt instanceof Date);
});

test('a meeting whose remindAt is still in the future is left untouched', async () => {
  const m = await makeMeeting({
    title: 'REMINDER_TEST_early',
    scheduledAt: minutesFromNow(120),
    remindAt: minutesFromNow(110),
  });
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

test('a reminder long overdue is still picked up — a late tick cannot lose it', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_overdue', remindAt: minutesFromNow(-45) });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.reminderRetry?.attempts, 1, 'due means due, however late the pass runs');
});

test('a meeting with no remindAt is never reminded', async () => {
  const m = await makeMeeting({ title: 'REMINDER_TEST_null', remindAt: null });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.reminderSentAt, null);
  assert.equal(after.reminderRetry?.attempts ?? 0, 0);
});

test('a reminder whose interview already started is retired without sending', async () => {
  const m = await makeMeeting({
    title: 'REMINDER_TEST_started',
    scheduledAt: minutesFromNow(-5),
    remindAt: minutesFromNow(-15),
  });
  await meetingService.sendUpcomingMeetingReminders();
  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.reminderSentAt instanceof Date, 'a stale reminder is retired, not retried forever');
});

test('computeRemindAt drops a lead time that is already past at booking', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  assert.equal(
    meetingService.computeRemindAt(new Date('2026-01-01T12:30:00.000Z'), now).toISOString(),
    '2026-01-01T12:20:00.000Z'
  );
  assert.equal(meetingService.computeRemindAt(new Date('2026-01-01T12:05:00.000Z'), now), null);
  assert.equal(meetingService.computeRemindAt(null), null);
});
