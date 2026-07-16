import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import JobApplication from '../../models/jobApplication.model.js';
import Employee from '../../models/employee.model.js';
import User from '../../models/user.model.js';
import Job from '../../models/job.model.js';
import { aggregateApplicantsByStatus, countApplicants } from '../applicantQuery.service.js';

const TEST_URI = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_jobstats';

const adminUser = {
  _id: new mongoose.Types.ObjectId(),
  id: null,
  email: 'admin-jobstats@test.local',
  roleIds: [],
  platformSuperUser: true,
};

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_URI);
  }
});

test.after(async () => {
  await JobApplication.deleteMany({ notes: 'JOBSTATS_TEST' });
  await Employee.deleteMany({ email: /@jobstats-test\.local$/ });
  await Job.deleteMany({ title: 'JOBSTATS_TEST_JOB' });
  await User.deleteMany({ email: 'admin-jobstats@test.local' });
});

test('aggregateApplicantsByStatus matches countApplicants after status change to Hired', async (t) => {
  const user = await User.create({
    _id: adminUser._id,
    name: 'Stats Admin',
    email: adminUser.email,
    password: 'Password1!',
    status: 'active',
  });

  const job = await Job.create({
    title: 'JOBSTATS_TEST_JOB',
    organisation: { name: 'Test Co' },
    jobDescription: 'Test',
    jobType: 'Full-time',
    location: 'Remote',
    status: 'Active',
    createdBy: user._id,
  });

  const candidateRows = await Promise.all(
    ['hardik@jobstats-test.local', 'jaymin@jobstats-test.local'].map((email, i) =>
      Employee.create({
        owner: user._id,
        adminId: user._id,
        fullName: i === 0 ? 'Hardik' : 'Jaymin',
        email,
        phoneNumber: '9999999999',
        isActive: true,
      })
    )
  );

  const apps = await Promise.all(
    candidateRows.map((candidate) =>
      JobApplication.create({
        job: job._id,
        candidate: candidate._id,
        status: 'Hired',
        notes: 'JOBSTATS_TEST',
      })
    )
  );

  const filter = { jobId: String(job._id) };
  const currentUser = { ...adminUser, id: String(user._id), _id: user._id, platformSuperUser: true };

  const [total, funnel] = await Promise.all([
    countApplicants(filter, currentUser),
    aggregateApplicantsByStatus(filter, currentUser),
  ]);

  assert.equal(total, 2, 'countApplicants should see both hired applications');
  const hiredRow = funnel.find((row) => row.status === 'Hired');
  assert.ok(hiredRow, `funnel should include Hired row, got: ${JSON.stringify(funnel)}`);
  assert.equal(hiredRow.count, 2, 'Hired count should match total hired applications');

  await JobApplication.deleteMany({ _id: { $in: apps.map((a) => a._id) } });
});
