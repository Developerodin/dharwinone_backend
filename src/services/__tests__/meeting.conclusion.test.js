import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Meeting from '../../models/meeting.model.js';
import * as meetingService from '../meeting.service.js';
import { buildInterviewConclusionEmail } from '../email.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test';
const minutesAgo = (m) => new Date(Date.now() - m * 60000);

test.before(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await Meeting.deleteMany({ title: /^CONCLUSION_TEST_/ });
});
test.after(async () => {
  await Meeting.deleteMany({ title: /^CONCLUSION_TEST_/ });
  await mongoose.disconnect();
});

test('autoEndExpiredMeetings ends expired meetings and stamps interviewCompletedAt', async () => {
  const m = await Meeting.create({
    meetingId: `cend_${Date.now()}`,
    roomName: `cend_${Date.now()}`,
    title: 'CONCLUSION_TEST_autoend',
    scheduledAt: minutesAgo(120),
    durationMinutes: 60,
    hosts: [{ email: 'h@x.com' }],
    createdBy: new mongoose.Types.ObjectId(),
  });

  await meetingService.autoEndExpiredMeetings();

  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.status, 'ended');
  assert.ok(after.interviewCompletedAt instanceof Date);
});

test('autoEndExpiredMeetings does not overwrite an existing interviewCompletedAt', async () => {
  const stamp = minutesAgo(200);
  const m = await Meeting.create({
    meetingId: `ckeep_${Date.now()}`,
    roomName: `ckeep_${Date.now()}`,
    title: 'CONCLUSION_TEST_keepstamp',
    scheduledAt: minutesAgo(120),
    durationMinutes: 60,
    status: 'scheduled',
    interviewCompletedAt: stamp,
    hosts: [{ email: 'h@x.com' }],
    createdBy: new mongoose.Types.ObjectId(),
  });

  await meetingService.autoEndExpiredMeetings();

  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.interviewCompletedAt.toISOString(), stamp.toISOString());
});

test('buildInterviewConclusionEmail renders title, time-in-zone, and link', () => {
  const out = buildInterviewConclusionEmail({
    title: 'Frontend Interview',
    scheduledAt: new Date('2026-05-20T11:00:00.000Z'),
    timezone: 'UTC',
    candidateName: 'Jane Roe',
    link: 'https://app.example.com/interviews/abc',
  });
  assert.match(out.subject, /Frontend Interview/);
  assert.match(out.text, /Jane Roe/);
  assert.match(out.text, /2026/);
  assert.match(out.text, /https:\/\/app\.example\.com\/interviews\/abc/);
  assert.match(out.html, /Frontend Interview/);
});

const conclusionMeeting = (overrides) =>
  Meeting.create({
    meetingId: `con_${Math.random().toString(16).slice(2)}`,
    roomName: `con_${Math.random().toString(16).slice(2)}`,
    title: 'CONCLUSION_TEST_pass',
    scheduledAt: minutesAgo(120),
    durationMinutes: 60,
    status: 'ended',
    interviewResult: 'pending',
    interviewCompletedAt: minutesAgo(60),
    hosts: [{ email: 'host@example.com' }],
    recruiter: { id: String(new mongoose.Types.ObjectId()), email: 'rec@example.com' },
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  });

test('conclusion pass marks conclusionNotifiedAt for an ended, pending interview', async () => {
  const m = await conclusionMeeting({ title: 'CONCLUSION_TEST_fires' });
  await meetingService.sendInterviewConclusionNotifications();
  const after = await Meeting.findById(m._id).lean();
  assert.ok(after.conclusionNotifiedAt instanceof Date);
});

test('conclusion pass skips a decided interview', async () => {
  const m = await conclusionMeeting({ title: 'CONCLUSION_TEST_decided', interviewResult: 'selected' });
  await meetingService.sendInterviewConclusionNotifications();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.conclusionNotifiedAt, null);
});

test('conclusion pass does not fire before anchor + delay', async () => {
  const m = await conclusionMeeting({
    title: 'CONCLUSION_TEST_tooearly',
    interviewCompletedAt: minutesAgo(5),
  });
  await meetingService.sendInterviewConclusionNotifications();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.conclusionNotifiedAt, null);
});

test('conclusion pass does not re-fire once notified', async () => {
  const m = await conclusionMeeting({
    title: 'CONCLUSION_TEST_norefire',
    conclusionNotifiedAt: minutesAgo(10),
  });
  const before = await Meeting.findById(m._id).lean();
  await meetingService.sendInterviewConclusionNotifications();
  const after = await Meeting.findById(m._id).lean();
  assert.equal(after.conclusionNotifiedAt.toISOString(), before.conclusionNotifiedAt.toISOString());
});
