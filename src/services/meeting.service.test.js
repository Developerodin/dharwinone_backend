import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Notification from '../models/notification.model.js';
import Offer from '../models/offer.model.js';
import Placement from '../models/placement.model.js';
import * as meetingService from './meeting.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test';

// Tracks docs created by this suite so cleanup can delete precisely (no broad
// regex sweeps that could touch data from other concurrently-running test files).
const createdUserIds = [];
const createdEmployeeIds = [];
const createdJobIds = [];
const createdApplicationIds = [];
const createdMeetingIds = [];

const uid = () => Math.random().toString(16).slice(2);

const makeUser = async (label) => {
  const user = await User.create({
    name: `MTG_NOTIFY_TEST User ${label}`,
    email: `mtgnotify.${label}.${uid()}@notifytest.example.com`,
    password: 'Passw0rd123',
  });
  createdUserIds.push(user._id);
  return user;
};

const makeMeeting = async ({ candidate, recruiter, jobPosition, interviewResult = 'pending' } = {}) => {
  const id = `mtgnotify_${uid()}`;
  const meeting = await Meeting.create({
    meetingId: id,
    roomName: id,
    title: 'MTG_NOTIFY_TEST_interview',
    scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
    durationMinutes: 30,
    interviewResult,
    jobPosition,
    candidate,
    recruiter,
    createdBy: new mongoose.Types.ObjectId(),
  });
  createdMeetingIds.push(meeting._id);
  return meeting;
};

const candidateNotifications = (userId) =>
  Notification.find({ user: userId, type: 'job_application' }).lean();

test.before(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(TEST_URI);
});

test.after(async () => {
  // The 'selected' transition also drives the pre-existing move-to-preboarding pipeline
  // (createPlacementFromInterview), which drafts a real Offer for the metadata fixture's
  // application — clean that up too so this suite leaves no stray docs in the test DB.
  const offers = await Offer.find({ jobApplication: { $in: createdApplicationIds } }).select('_id').lean();
  const offerIds = offers.map((o) => o._id);
  await Placement.deleteMany({ offer: { $in: offerIds } });
  await Offer.deleteMany({ _id: { $in: offerIds } });
  await Notification.deleteMany({ user: { $in: createdUserIds } });
  await Meeting.deleteMany({ _id: { $in: createdMeetingIds } });
  await JobApplication.deleteMany({ _id: { $in: createdApplicationIds } });
  await Employee.deleteMany({ _id: { $in: createdEmployeeIds } });
  await Job.deleteMany({ _id: { $in: createdJobIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.disconnect();
});

test('pending -> selected creates exactly one candidate notification', async () => {
  const candidate = await makeUser('sel1');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Backend Engineer',
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString());

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].title, "Congratulations! You've Been Selected");
  assert.match(notifs[0].message, /MTG_NOTIFY_TEST_JOB_Backend Engineer/);
});

test('pending -> rejected creates exactly one candidate notification', async () => {
  const candidate = await makeUser('rej1');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_QA Engineer',
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'rejected' }, new mongoose.Types.ObjectId().toString());

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].title, 'Application Update');
  assert.match(notifs[0].message, /not selected to move forward/);
});

test('selected -> selected creates no new notification', async () => {
  const candidate = await makeUser('selsel');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Already Selected',
    interviewResult: 'selected',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString());

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 0);
});

test('rejected -> rejected creates no new notification', async () => {
  const candidate = await makeUser('rejrej');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Already Rejected',
    interviewResult: 'rejected',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'rejected' }, new mongoose.Types.ObjectId().toString());

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 0);
});

test('repeated identical update does not duplicate the notification', async () => {
  const candidate = await makeUser('repeat');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Repeat Role',
    interviewResult: 'pending',
  });

  const actorId = new mongoose.Types.ObjectId().toString();
  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, actorId);
  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, actorId);

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 1);
});

test('notifies the candidate User, never the recruiter', async () => {
  const candidate = await makeUser('cand6');
  const recruiter = await makeUser('rec6');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    recruiter: { id: recruiter._id.toString(), email: recruiter.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Recipient Check',
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString());

  const candidateNotifs = await candidateNotifications(candidate._id);
  const recruiterNotifCount = await Notification.countDocuments({ user: recruiter._id });
  assert.equal(candidateNotifs.length, 1);
  assert.equal(candidateNotifs[0].user.toString(), candidate._id.toString());
  assert.equal(recruiterNotifCount, 0);
});

test('an unrelated candidate receives no notification from another candidate\'s selection', async () => {
  const candidate = await makeUser('cand6b');
  const unrelated = await makeUser('unrelated6b');
  const meeting = await makeMeeting({
    candidate: { email: candidate.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_Isolation Check',
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString());

  // The selected candidate gets exactly one; the unrelated User gets nothing at all.
  assert.equal((await candidateNotifications(candidate._id)).length, 1);
  assert.equal(await Notification.countDocuments({ user: unrelated._id }), 0);
});

test('notification carries correct job/application metadata and the candidate My Applications link', async () => {
  const candidate = await makeUser('meta7');
  const adminId = new mongoose.Types.ObjectId();

  const employee = await Employee.create({
    owner: adminId,
    adminId,
    fullName: 'MTG_NOTIFY_TEST Candidate Seven',
    email: candidate.email,
    phoneNumber: '+10000000000',
  });
  createdEmployeeIds.push(employee._id);

  const job = await Job.create({
    organisation: { name: 'MTG_NOTIFY_TEST_ORG' },
    title: 'MTG_NOTIFY_TEST_JOB_Metadata Role',
    jobDescription: 'A role used only to verify notification metadata.',
    jobType: 'Full-time',
    location: 'Remote',
    createdBy: adminId,
  });
  createdJobIds.push(job._id);

  const application = await JobApplication.create({
    job: job._id,
    candidate: employee._id,
    status: 'Interview',
  });
  createdApplicationIds.push(application._id);

  const meeting = await makeMeeting({
    candidate: { id: employee._id.toString(), email: candidate.email },
    jobPosition: job.title,
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString());

  const notifs = await candidateNotifications(candidate._id);
  assert.equal(notifs.length, 1);
  const notif = notifs[0];

  // Job/application metadata is present and correct.
  assert.equal(notif.metadata?.jobId, job._id.toString());
  assert.equal(notif.metadata?.applicationId, application._id.toString());

  // Job title appears in the message.
  assert.match(notif.message, /MTG_NOTIFY_TEST_JOB_Metadata Role/);

  // The link must be the explicit candidate My Applications route — the job_application
  // resolver falls back to the recruiter-facing /ats/jobs/:id route when metadata.jobId is
  // set and no explicit link is passed, so this guards against that regression even though
  // metadata.jobId is present here.
  assert.equal(notif.link, '/ats/my-applications');

  assert.equal(notif.type, 'job_application');
});

test('no User account for the candidate email: logs and skips, never falls back to the recruiter', async () => {
  const recruiter = await makeUser('rec10');
  const meeting = await makeMeeting({
    candidate: { email: `mtgnotify.unregistered.${uid()}@notifytest.example.com` },
    recruiter: { id: recruiter._id.toString(), email: recruiter.email },
    jobPosition: 'MTG_NOTIFY_TEST_JOB_No Account',
    interviewResult: 'pending',
  });

  await assert.doesNotReject(
    meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, new mongoose.Types.ObjectId().toString())
  );

  const recruiterNotifCount = await Notification.countDocuments({ user: recruiter._id });
  assert.equal(recruiterNotifCount, 0);

  const after = await Meeting.findById(meeting._id).lean();
  assert.equal(after.interviewResult, 'selected');
});

test('pending -> rejected cascades JobApplication.status to Rejected', async () => {
  const candidate = await makeUser('rejapp1');
  const adminId = new mongoose.Types.ObjectId();

  const employee = await Employee.create({
    owner: adminId,
    adminId,
    fullName: 'MTG_NOTIFY_TEST Candidate Reject',
    email: candidate.email,
    phoneNumber: '+10000000001',
  });
  createdEmployeeIds.push(employee._id);

  const job = await Job.create({
    organisation: { name: 'MTG_NOTIFY_TEST_ORG' },
    title: 'MTG_NOTIFY_TEST_JOB_Reject Cascade',
    jobDescription: 'Verify rejection cascades to application.',
    jobType: 'Full-time',
    location: 'Remote',
    createdBy: adminId,
  });
  createdJobIds.push(job._id);

  const application = await JobApplication.create({
    job: job._id,
    candidate: employee._id,
    status: 'Interview',
  });
  createdApplicationIds.push(application._id);

  const meeting = await makeMeeting({
    candidate: { id: employee._id.toString(), email: candidate.email },
    jobPosition: job.title,
    interviewResult: 'pending',
  });

  await meetingService.updateMeetingById(
    meeting._id.toString(),
    { interviewResult: 'rejected' },
    new mongoose.Types.ObjectId().toString()
  );

  const updated = await JobApplication.findById(application._id).lean();
  assert.equal(updated.status, 'Rejected');
});

test('selected -> rejected rolls back offer and sets JobApplication Rejected', async () => {
  const candidate = await makeUser('rejapp2');
  const adminId = new mongoose.Types.ObjectId();

  const employee = await Employee.create({
    owner: adminId,
    adminId,
    fullName: 'MTG_NOTIFY_TEST Candidate Reject Selected',
    email: candidate.email,
    phoneNumber: '+10000000002',
  });
  createdEmployeeIds.push(employee._id);

  const job = await Job.create({
    organisation: { name: 'MTG_NOTIFY_TEST_ORG' },
    title: 'MTG_NOTIFY_TEST_JOB_Reject After Selected',
    jobDescription: 'Verify selected→rejected rollback.',
    jobType: 'Full-time',
    location: 'Remote',
    createdBy: adminId,
  });
  createdJobIds.push(job._id);

  const application = await JobApplication.create({
    job: job._id,
    candidate: employee._id,
    status: 'Interview',
  });
  createdApplicationIds.push(application._id);

  const meeting = await makeMeeting({
    candidate: { id: employee._id.toString(), email: candidate.email },
    jobPosition: job.title,
    interviewResult: 'pending',
  });

  const actorId = new mongoose.Types.ObjectId().toString();
  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, actorId);

  const afterSelect = await JobApplication.findById(application._id).lean();
  assert.equal(afterSelect.status, 'Offered');
  assert.equal(await Offer.countDocuments({ jobApplication: application._id }), 1);

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'rejected' }, actorId);

  const afterReject = await JobApplication.findById(application._id).lean();
  assert.equal(afterReject.status, 'Rejected');
  assert.equal(await Offer.countDocuments({ jobApplication: application._id }), 0);
});

test('rejected -> selected preserves selection flow (offer created)', async () => {
  const candidate = await makeUser('rejapp3');
  const adminId = new mongoose.Types.ObjectId();

  const employee = await Employee.create({
    owner: adminId,
    adminId,
    fullName: 'MTG_NOTIFY_TEST Candidate Reopen Selected',
    email: candidate.email,
    phoneNumber: '+10000000003',
  });
  createdEmployeeIds.push(employee._id);

  const job = await Job.create({
    organisation: { name: 'MTG_NOTIFY_TEST_ORG' },
    title: 'MTG_NOTIFY_TEST_JOB_Rejected To Selected',
    jobDescription: 'Verify rejected→selected still creates offer.',
    jobType: 'Full-time',
    location: 'Remote',
    createdBy: adminId,
  });
  createdJobIds.push(job._id);

  const application = await JobApplication.create({
    job: job._id,
    candidate: employee._id,
    status: 'Interview',
  });
  createdApplicationIds.push(application._id);

  const meeting = await makeMeeting({
    candidate: { id: employee._id.toString(), email: candidate.email },
    jobPosition: job.title,
    interviewResult: 'pending',
  });

  const actorId = new mongoose.Types.ObjectId().toString();
  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'rejected' }, actorId);
  assert.equal((await JobApplication.findById(application._id).lean()).status, 'Rejected');

  await meetingService.updateMeetingById(meeting._id.toString(), { interviewResult: 'selected' }, actorId);

  const afterReselect = await JobApplication.findById(application._id).lean();
  assert.equal(afterReselect.status, 'Offered');
  assert.equal(await Offer.countDocuments({ jobApplication: application._id }), 1);
});
