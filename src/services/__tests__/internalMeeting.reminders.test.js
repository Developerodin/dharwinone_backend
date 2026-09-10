import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import InternalMeeting from '../../models/internalMeeting.model.js';
import EmailLog from '../../models/emailLog.model.js';
import {
  sendUpcomingInternalMeetingReminders,
  buildReminderSchedule,
} from '../internalMeeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_reminders';
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);
const GUEST = 'int-reminder-guest@example.com';

const waitForEmailLog = async (to, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const row = await EmailLog.findOne({ to }).lean();
    if (row) return row;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share one ' +
      'MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL to a dedicated database.'
  );
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await InternalMeeting.deleteMany({ title: /^INT_REMINDER_TEST_/ });
  await EmailLog.deleteMany({ to: GUEST });
});

test.after(async () => {
  await InternalMeeting.deleteMany({ title: /^INT_REMINDER_TEST_/ });
  await EmailLog.deleteMany({ to: GUEST });
  await mongoose.disconnect();
});

/** A meeting 10 minutes out whose 10-minute reminder came due 30 seconds ago. */
const makeMeeting = (overrides = {}) => {
  const id = `intrem_${Math.random().toString(16).slice(2)}`;
  return InternalMeeting.create({
    meetingId: id,
    roomName: id,
    title: 'INT_REMINDER_TEST_base',
    scheduledAt: minutesFromNow(10),
    durationMinutes: 30,
    status: 'scheduled',
    hosts: [],
    emailInvites: [],
    createdBy: new mongoose.Types.ObjectId(),
    reminders: [{ leadMinutes: 10, dueAt: minutesFromNow(-0.5), sentAt: null }],
    ...overrides,
  });
};

const entryFor = (doc, leadMinutes = 10) =>
  (doc.reminders || []).find((r) => r.leadMinutes === leadMinutes);

test('a due reminder that reached nobody is handed back so the next tick retries', async () => {
  const m = await makeMeeting({ title: 'INT_REMINDER_TEST_release' });
  await sendUpcomingInternalMeetingReminders();
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal(entryFor(after).sentAt, null, 'an undelivered reminder must not stay claimed');
  assert.equal(after.reminderSentAt, null);
});

test('a reminder that is not due yet is untouched', async () => {
  const m = await makeMeeting({
    title: 'INT_REMINDER_TEST_far',
    scheduledAt: minutesFromNow(180),
    reminders: [{ leadMinutes: 10, dueAt: minutesFromNow(170), sentAt: null }],
  });
  await sendUpcomingInternalMeetingReminders();
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal(entryFor(after).sentAt, null);
});

test('a cancelled meeting is never reminded', async () => {
  const m = await makeMeeting({ title: 'INT_REMINDER_TEST_cancelled', status: 'cancelled' });
  await sendUpcomingInternalMeetingReminders();
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal(entryFor(after).sentAt, null);
});

test('a reminder whose meeting already started is retired without sending', async () => {
  const m = await makeMeeting({
    title: 'INT_REMINDER_TEST_started',
    scheduledAt: minutesFromNow(-5),
    reminders: [{ leadMinutes: 10, dueAt: minutesFromNow(-15), sentAt: null }],
    hosts: [{ email: 'int-reminder-late@example.com' }],
  });
  await sendUpcomingInternalMeetingReminders();
  const after = await InternalMeeting.findById(m._id).lean();
  assert.ok(entryFor(after).sentAt instanceof Date, 'a stale reminder must be retired, not retried forever');
  const row = await EmailLog.findOne({ to: 'int-reminder-late@example.com' }).lean();
  assert.equal(row, null, 'a meeting that already started must not send "starts soon"');
});

test('an invitee with no account still gets the reminder email', async () => {
  const m = await makeMeeting({
    title: 'INT_REMINDER_TEST_guest',
    hosts: [{ email: GUEST }],
  });
  await sendUpcomingInternalMeetingReminders();
  const row = await waitForEmailLog(GUEST);
  assert.ok(row, 'a guest invitee must receive the reminder email');
  const after = await InternalMeeting.findById(m._id).lean();
  assert.ok(entryFor(after).sentAt instanceof Date, 'a delivered reminder stays claimed');
});

test('a window the previous band code already sent is not sent again', async () => {
  const m = await makeMeeting({
    title: 'INT_REMINDER_TEST_legacy',
    hosts: [{ email: 'int-reminder-legacy@example.com' }],
    reminderState: new Map([['10', new Date()]]),
    reminderSentAt: new Date(),
  });
  await sendUpcomingInternalMeetingReminders();
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal(entryFor(after).sentAt, null, 'the entry stays unclaimed');
  const row = await EmailLog.findOne({ to: 'int-reminder-legacy@example.com' }).lean();
  assert.equal(row, null, 'a meeting reminded under the old model must not be reminded twice');
});

test('buildReminderSchedule drops lead times that have already passed', async () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const start = new Date('2026-01-01T12:13:00.000Z'); // booked 13 minutes ahead
  const schedule = buildReminderSchedule(start, now);
  assert.deepEqual(
    schedule.map((r) => r.leadMinutes),
    [10],
    'the 60-minute lead is already past at booking and must not be materialised'
  );
  assert.equal(schedule[0].dueAt.toISOString(), '2026-01-01T12:03:00.000Z');
  assert.deepEqual(buildReminderSchedule(null), []);
});
