import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Job from '../../models/job.model.js';
import { getInvitationEmails, resolveJobPositionDisplayTitle } from '../meeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test';

test.before(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
});

test.after(async () => {
  await Job.deleteMany({ title: /^INVITE_EMAIL_TEST_/ });
});

test('getInvitationEmails merges hosts + candidate + recruiter + agents, deduped + lowercased', () => {
  const emails = getInvitationEmails({
    hosts: [{ email: 'Host@x.com' }],
    emailInvites: ['Invite@x.com'],
    candidate: { email: 'Cand@x.com' },
    recruiter: { email: 'Rec@x.com' },
    agents: [
      { id: 'a1', email: 'AGENT1@x.com' },
      { id: 'a2', email: 'agent2@x.com' },
      { id: 'a3' },
      { id: 'a4', email: 'agent1@x.com' },
    ],
  });
  assert.deepEqual(
    new Set(emails),
    new Set(['host@x.com', 'invite@x.com', 'cand@x.com', 'rec@x.com', 'agent1@x.com', 'agent2@x.com'])
  );
});

test('getInvitationEmails tolerates a meeting with no agents', () => {
  const emails = getInvitationEmails({ hosts: [{ email: 'h@x.com' }] });
  assert.deepEqual(emails, ['h@x.com']);
});

test('resolveJobPositionDisplayTitle returns title when jobPosition is a Job ObjectId', async () => {
  const job = await Job.create({
    organisation: { name: 'Invite Test Co' },
    title: 'INVITE_EMAIL_TEST_Software Engineer',
    jobDescription: 'Test role',
    jobType: 'Full-time',
    location: 'Remote',
    createdBy: new mongoose.Types.ObjectId(),
  });

  const display = await resolveJobPositionDisplayTitle(String(job._id));
  assert.equal(display, 'INVITE_EMAIL_TEST_Software Engineer');
});

test('resolveJobPositionDisplayTitle passes through plain-text job titles', async () => {
  const display = await resolveJobPositionDisplayTitle('Product Manager');
  assert.equal(display, 'Product Manager');
});

test('resolveJobPositionDisplayTitle returns em dash when ObjectId has no matching job', async () => {
  const missingId = new mongoose.Types.ObjectId();
  const display = await resolveJobPositionDisplayTitle(String(missingId));
  assert.equal(display, '—');
});

test('resolveJobPositionDisplayTitle returns empty string when jobPosition is blank', async () => {
  assert.equal(await resolveJobPositionDisplayTitle(''), '');
  assert.equal(await resolveJobPositionDisplayTitle(null), '');
  assert.equal(await resolveJobPositionDisplayTitle(undefined), '');
});

test('getInvitationEmails includes hosts and emailInvites for internal-style meetings', () => {
  const emails = getInvitationEmails({
    hosts: [{ email: 'host@x.com', nameOrRole: 'Host' }],
    emailInvites: ['akbar.mohammed@dharwinbusinesssolutions.com', 'host@x.com'],
  });
  assert.deepEqual(
    new Set(emails),
    new Set(['host@x.com', 'akbar.mohammed@dharwinbusinesssolutions.com'])
  );
});
