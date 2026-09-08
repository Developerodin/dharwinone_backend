import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import InternalMeeting from '../../models/internalMeeting.model.js';
import EmailLog from '../../models/emailLog.model.js';
import { sendInternalMeetingRemindersForWindow } from '../internalMeeting.service.js';

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

const makeMeeting = (overrides = {}) => {
  const id = `intrem_${Math.random().toString(16).slice(2)}`;
  return InternalMeeting.create({
    meetingId: id,
    roomName: id,
    title: 'INT_REMINDER_TEST_base',
    scheduledAt: minutesFromNow(15),
    durationMinutes: 30,
    status: 'scheduled',
    hosts: [],
    emailInvites: [],
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  });
};

test('a window that reached nobody releases its claim so the next tick can retry', async () => {
  const m = await makeMeeting({ title: 'INT_REMINDER_TEST_release' });
  await sendInternalMeetingRemindersForWindow({ minutes: 15, label: '15 minutes' });
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal((after.reminderState || {})['15'], undefined, 'an undelivered window must not stay claimed');
  assert.equal(after.reminderSentAt, null);
});

test('a meeting outside the window is untouched', async () => {
  const m = await makeMeeting({ title: 'INT_REMINDER_TEST_far', scheduledAt: minutesFromNow(180) });
  await sendInternalMeetingRemindersForWindow({ minutes: 15, label: '15 minutes' });
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal((after.reminderState || {})['15'], undefined);
});

test('a cancelled meeting is never reminded', async () => {
  const m = await makeMeeting({ title: 'INT_REMINDER_TEST_cancelled', status: 'cancelled' });
  await sendInternalMeetingRemindersForWindow({ minutes: 15, label: '15 minutes' });
  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal((after.reminderState || {})['15'], undefined);
});

test('an invitee with no account still gets the reminder email', async () => {
  const m = await makeMeeting({
    title: 'INT_REMINDER_TEST_guest',
    hosts: [{ email: GUEST }],
  });
  await sendInternalMeetingRemindersForWindow({ minutes: 15, label: '15 minutes' });
  const row = await waitForEmailLog(GUEST);
  assert.ok(row, 'a guest invitee must receive the reminder email');
});
