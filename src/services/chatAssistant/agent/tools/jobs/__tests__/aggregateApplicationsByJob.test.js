// applicantQuery.service aggregateApplicationsByJob — the grouped per-job count get_job_stats ranks by.
// No database: the model statics it calls are swapped for recorders; Query#cast runs for real.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import JobApplication from '../../../../../../models/jobApplication.model.js';
import Employee from '../../../../../../models/employee.model.js';
import User from '../../../../../../models/user.model.js';
import { aggregateApplicationsByJob } from '../../../../../applicantQuery.service.js';

const J1 = '64b7f0c2a1b2c3d4e5f60718';
const J2 = '64b7f0c2a1b2c3d4e5f60719';
const CAND = '64b7f0c2a1b2c3d4e5f60aaa';
// platformSuperUser → applicationScope returns {} without a role lookup.
const ADMIN = { _id: '64b7f0c2a1b2c3d4e5f60fff', platformSuperUser: true };

const lean = (rows) => ({ lean: async () => rows });
const activeCandidates = () => lean([{ _id: new mongoose.Types.ObjectId(CAND) }]);
const saved = {};
let pipelines = [];
let aggRows = [];

before(() => {
  saved.aggregate = JobApplication.aggregate;
  saved.employeeFind = Employee.find;
  saved.userFind = User.find;
  JobApplication.aggregate = async (p) => { pipelines.push(p); return aggRows; };
  User.find = () => lean([{ _id: new mongoose.Types.ObjectId() }]);
  Employee.find = activeCandidates;
});
after(() => {
  JobApplication.aggregate = saved.aggregate;
  Employee.find = saved.employeeFind;
  User.find = saved.userFind;
});

describe('aggregateApplicationsByJob', () => {
  it('casts the scoped filter (string ids → ObjectIds) and dedupes like applyDedupeIfRequested', async () => {
    pipelines = [];
    aggRows = [];
    await aggregateApplicationsByJob({ jobIds: [J1, J2] }, ADMIN);
    const [match, project, sort, group, replaceRoot, lookup] = pipelines[0];
    const jobIn = match.$match.job.$in;
    assert.ok(jobIn.every((id) => id instanceof mongoose.Types.ObjectId), 'aggregate $match needs cast ObjectIds');
    assert.deepEqual(jobIn.map(String), [J1, J2]);
    assert.ok(match.$match.candidate.$in[0] instanceof mongoose.Types.ObjectId, 'active-candidate filter kept, like the page');
    assert.deepEqual(project.$project.status, { $ifNull: ['$status', 'Applied'] });
    assert.deepEqual(sort, { $sort: { createdAt: -1, _id: -1 } });
    assert.deepEqual(group.$group._id, { job: '$job', who: { $ifNull: ['$applicantUser', '$candidate'] } });
    assert.deepEqual(group.$group.doc, { $first: '$$ROOT' });
    assert.ok(replaceRoot.$replaceRoot);
    assert.equal(lookup.$lookup.from, 'meetings');
    assert.deepEqual(lookup.$lookup.pipeline[0].$match.status, { $ne: 'cancelled' });
  });

  it('includeDuplicates skips the dedupe stages', async () => {
    pipelines = [];
    await aggregateApplicationsByJob({ jobIds: [J1], includeDuplicates: true }, ADMIN);
    assert.equal(pipelines[0].some((s) => s.$sort || s.$replaceRoot), false);
  });

  it('folds (job, status) groups into one row per job', async () => {
    aggRows = [
      { _id: { job: new mongoose.Types.ObjectId(J1), status: 'Applied' }, count: 2, lastAppliedAt: new Date('2026-09-01'), interviewed: 0 },
      { _id: { job: new mongoose.Types.ObjectId(J1), status: 'Rejected' }, count: 1, lastAppliedAt: new Date('2026-09-20'), interviewed: 1 },
      { _id: { job: new mongoose.Types.ObjectId(J2), status: 'Hired' }, count: 1, lastAppliedAt: new Date('2026-08-01'), interviewed: 1 },
    ];
    const out = await aggregateApplicationsByJob({ jobIds: [J1, J2] }, ADMIN);
    const byId = Object.fromEntries(out.map((r) => [r.jobId, r]));
    assert.deepEqual(byId[J1], {
      jobId: J1, total: 3, byStage: { Applied: 2, Rejected: 1 }, lastAppliedAt: new Date('2026-09-20'), interviewed: 1,
    });
    assert.equal(byId[J2].total, 1);
    assert.equal(byId[J2].interviewed, 1);
    aggRows = [];
  });

  it('an empty scope returns [] without aggregating', async () => {
    pipelines = [];
    Employee.find = () => lean([]); // department with no matching employees short-circuits buildApplicantQuery
    try {
      assert.deepEqual(await aggregateApplicationsByJob({ jobIds: [J1], department: 'Nowhere' }, ADMIN), []);
    } finally {
      Employee.find = activeCandidates;
    }
    assert.equal(pipelines.length, 0);
  });
});
