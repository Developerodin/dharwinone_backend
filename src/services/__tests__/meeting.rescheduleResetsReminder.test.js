import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import Meeting from '../../models/meeting.model.js';
import InternalMeeting from '../../models/internalMeeting.model.js';
import * as meetingService from '../meeting.service.js';
import { updateInternalMeetingById } from '../internalMeeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_reminders';
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share one ' +
      'MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL to a dedicated database.'
  );
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await Meeting.deleteMany({ title: /^RESCHED_TEST_/ });
  await InternalMeeting.deleteMany({ title: /^RESCHED_TEST_/ });
});

test.after(async () => {
  await Meeting.deleteMany({ title: /^RESCHED_TEST_/ });
  await InternalMeeting.deleteMany({ title: /^RESCHED_TEST_/ });
  await mongoose.disconnect();
});

const rid = () => `resched_${Math.random().toString(16).slice(2)}`;

test('moving an interview clears its sent marker so the new time is reminded', async () => {
  const id = rid();
  const m = await Meeting.create({
    meetingId: id,
    roomName: id,
    title: 'RESCHED_TEST_interview',
    scheduledAt: minutesFromNow(10),
    remindAt: minutesFromNow(-0.5),
    durationMinutes: 60,
    status: 'scheduled',
    hosts: [{ email: 'host@example.com' }],
    createdBy: new mongoose.Types.ObjectId(),
    reminderSentAt: new Date(),
    reminderRetry: { attempts: 2, claimedAt: null },
  });

  await meetingService.updateMeetingById(m._id.toString(), { scheduledAt: minutesFromNow(300) });

  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.reminderSentAt, null);
  assert.equal(after.reminderRetry.attempts, 0);
});

test('editing an interview without moving it keeps the sent marker', async () => {
  const id = rid();
  const sentAt = new Date();
  const m = await Meeting.create({
    meetingId: id,
    roomName: id,
    title: 'RESCHED_TEST_notes_only',
    scheduledAt: minutesFromNow(10),
    remindAt: minutesFromNow(-0.5),
    durationMinutes: 60,
    status: 'scheduled',
    hosts: [{ email: 'host@example.com' }],
    createdBy: new mongoose.Types.ObjectId(),
    reminderSentAt: sentAt,
  });

  await meetingService.updateMeetingById(m._id.toString(), { notes: 'no time change' });

  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.reminderSentAt, 'an unrelated edit must not re-arm the reminder');
});

test('moving an internal meeting re-materialises its reminders for the new time', async () => {
  const id = rid();
  const m = await InternalMeeting.create({
    meetingId: id,
    roomName: id,
    title: 'RESCHED_TEST_internal',
    scheduledAt: minutesFromNow(10),
    reminders: [{ leadMinutes: 10, dueAt: minutesFromNow(-0.5), sentAt: new Date() }],
    durationMinutes: 30,
    status: 'scheduled',
    hosts: [{ email: 'host@example.com' }],
    createdBy: new mongoose.Types.ObjectId(),
    reminderSentAt: new Date(),
    reminderState: new Map([
      ['60', new Date()],
      ['15', new Date()],
    ]),
  });

  await updateInternalMeetingById(m._id.toString(), { scheduledAt: minutesFromNow(300) });

  const after = await InternalMeeting.findById(m._id).lean();
  assert.equal(after.reminderSentAt, null);
  assert.deepEqual(after.reminderState || {}, {});
  // The old entry referred to a start time that no longer exists; the new schedule is
  // rebuilt from the new one and is unsent, so the moved meeting gets reminded again.
  assert.ok(after.reminders.length > 0, 'a moved meeting must have a fresh reminder schedule');
  assert.ok(
    after.reminders.every((r) => r.sentAt === null && r.dueAt > new Date()),
    'every re-materialised reminder is unsent and still in the future'
  );
});
