import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import User from '../../models/user.model.js';
import EmailLog from '../../models/emailLog.model.js';
import { notify } from '../notification.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_reminders';
const email = 'channeliso@example.com';

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share one ' +
      'MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL to a dedicated database.'
  );
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
  await User.deleteMany({ email });
  await EmailLog.deleteMany({ to: email });
});

test.after(async () => {
  await User.deleteMany({ email });
  await EmailLog.deleteMany({ to: email });
  await mongoose.disconnect();
});

/** Poll for the row the fire-and-forget email queue writes asynchronously. */
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

test('an unwritable in-app notification does not suppress the email', async () => {
  const user = await User.create({
    name: 'Channel Isolation',
    email,
    password: 'password1',
    role: 'user',
  });

  // `title` is required on Notification, so the in-app write throws. The email is a
  // separate channel and must still be queued.
  const doc = await notify(user._id, {
    type: 'meeting_reminder',
    title: '',
    message: 'Your meeting starts in 15 minutes.',
    email: { subject: 'Reminder: standup starts soon', text: 'Your meeting starts in 15 minutes.' },
  });

  assert.equal(doc, null, 'the in-app write should have failed');
  const row = await waitForEmailLog(email);
  assert.ok(row, 'the reminder email should still have been queued');
});
