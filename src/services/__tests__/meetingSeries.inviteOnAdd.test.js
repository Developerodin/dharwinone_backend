import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import InternalMeeting from '../../models/internalMeeting.model.js';
import MeetingSeries from '../../models/meetingSeries.model.js';
import EmailLog from '../../models/emailLog.model.js';
import User from '../../models/user.model.js';
import {
  createMeetingSeries,
  updateSeries,
  sendDueOccurrenceInvites,
} from '../meetingSeries.service.js';

/**
 * Two reported defects, both silent:
 *
 * 1. Adding a participant to a recurring meeting emailed nobody. Adding an invitee is a
 *    content-only edit, and that branch of `updateSeries` wrote the new address onto every
 *    occurrence without ever sending an invitation — so the portal listed them under
 *    Participants & Invites while they were never told the meeting existed. Only a rule/time
 *    change ever sent, which is why one-off meetings worked and recurring ones did not.
 *
 * 2. A recipient whose notification preferences block meeting email was dropped before the
 *    send with no EmailLog row and no warning, and the caller still booked it as delivered.
 */

const TEST_URI =
  process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_meeting_series';

const TITLE = 'MSERIES_TEST_invite_on_add';
const HOST = 'mseries-host@example.com';
const EXISTING = 'mseries-existing@example.com';
const ADDED = 'mseries-added@example.com';
const MUTED = 'mseries-muted@example.com';
const ALL = [HOST, EXISTING, ADDED, MUTED];

const OWNER = new mongoose.Types.ObjectId();

/** EmailLog rows for one address, newest first. */
const logsFor = (to) => EmailLog.find({ to }).sort({ createdAt: -1 }).lean();

/** Poll briefly — the invite send is awaited but the audit write races the assertion. */
const waitForLog = async (to, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await logsFor(to);
    if (rows.length) return rows;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
};

const makeSeries = () =>
  createMeetingSeries(
    {
      title: TITLE,
      description: 'regression fixture',
      timezone: 'UTC',
      durationMinutes: 30,
      meetingType: 'Video',
      hosts: [{ nameOrRole: 'Host', email: HOST }],
      emailInvites: [EXISTING],
      recurrence: { frequency: 'daily', interval: 1 },
      startAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
      end: { mode: 'afterCount', count: 3 },
    },
    OWNER.toString()
  );

const cleanup = async () => {
  const ids = await MeetingSeries.find({ title: TITLE }).select('_id').lean();
  await InternalMeeting.deleteMany({ seriesId: { $in: ids.map((s) => s._id) } });
  await MeetingSeries.deleteMany({ title: TITLE });
  await EmailLog.deleteMany({ to: { $in: ALL } });
};

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share ' +
      'one MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL.'
  );
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await cleanup();
  await User.deleteMany({ email: { $in: ALL } });
  // Only this one has meeting email switched off; the others carry schema defaults (all true).
  await User.create({
    name: 'Muted Invitee',
    email: MUTED,
    password: 'Password1',
    notificationPreferences: { meetingInvitations: false },
  });
});

test.after(async () => {
  await cleanup();
  await User.deleteMany({ email: { $in: ALL } });
  await mongoose.disconnect();
});

test('adding a participant to a recurring meeting emails the new person', async () => {
  const series = await makeSeries();
  await EmailLog.deleteMany({ to: { $in: ALL } });

  // Content-only edit: the invite list changes, recurrence and start time do not. This is
  // what the Edit Meeting form sends when someone is added, and it used to email nobody.
  await updateSeries(String(series.occurrenceId), { emailInvites: [EXISTING, ADDED] }, 'series');

  const rows = await waitForLog(ADDED);
  assert.equal(rows.length, 1, 'the newly added participant should get exactly one invitation');
  assert.equal(rows[0].templateName, 'meetingInvitation');
  assert.equal(rows[0].status, 'sent');
});

test('an edit does not re-send invitations to people already invited', async () => {
  const series = await makeSeries();
  await EmailLog.deleteMany({ to: { $in: ALL } });

  await updateSeries(String(series.occurrenceId), { emailInvites: [EXISTING, ADDED] }, 'series');
  await waitForLog(ADDED);

  // Only the diff is emailed — otherwise every edit spams the whole invite list.
  assert.equal((await logsFor(EXISTING)).length, 0, 'existing invitee must not be re-emailed');
  assert.equal((await logsFor(HOST)).length, 0, 'host must not be re-emailed');
});

test('an invitee who muted meeting email gets a suppressed audit row, not silence', async () => {
  const series = await makeSeries();
  await EmailLog.deleteMany({ to: { $in: ALL } });

  await updateSeries(String(series.occurrenceId), { emailInvites: [EXISTING, MUTED] }, 'series');

  const rows = await waitForLog(MUTED);
  assert.equal(rows.length, 1, 'suppression must still leave an audit row');
  assert.equal(rows[0].status, 'suppressed');
  assert.equal(rows[0].templateName, 'meetingInvitation');
  assert.match(rows[0].error, /notification preferences/i);
});

test('a fully suppressed send does not stamp the occurrence as invited', async () => {
  // `invitationSentAt` is the "this occurrence has been invited" claim. Counting a suppressed
  // send as delivered stamped it anyway, so the occurrence reported invitations nobody
  // received and would never be retried.
  const series = await makeSeries();
  const seriesId = series.seriesId || series.id;
  const occurrence = await InternalMeeting.findById(series.occurrenceId);

  await MeetingSeries.updateOne(
    { _id: seriesId },
    { $set: { hosts: [{ nameOrRole: 'Host', email: MUTED }], emailInvites: [] } }
  );
  await InternalMeeting.updateOne({ _id: occurrence._id }, { $set: { invitationSentAt: null } });
  await EmailLog.deleteMany({ to: { $in: ALL } });

  await sendDueOccurrenceInvites({ now: new Date(occurrence.scheduledAt) });

  const after = await InternalMeeting.findById(occurrence._id).lean();
  assert.equal(
    after.invitationSentAt,
    null,
    'every recipient was suppressed, so nothing was delivered and nothing should be claimed'
  );
});
