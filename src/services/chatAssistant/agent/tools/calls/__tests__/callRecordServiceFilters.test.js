// callRecord.service's Sage additions against the REAL CallRecord schema (casting runs without a
// connection); only the Mongo round-trips are stubbed. Guards the two things the tool tests cannot:
// existing listCallRecords callers get the same filter, and aggregate $match is cast.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import CallRecord from '../../../../../../models/callRecord.model.js';
import Job from '../../../../../../models/job.model.js';
import Employee from '../../../../../../models/employee.model.js';
import callRecordService from '../../../../../callRecord.service.js';

const UID = '64b0000000000000000000a1';
const CAND = '64b0000000000000000000c3';
const JOB_OID = new mongoose.Types.ObjectId('64b0000000000000000000d4');

const saved = {};
const stub = (model, key, fn) => {
  saved[`${model.modelName}.${key}`] = [model, key, model[key]];
  model[key] = fn;
};
let lastCount;
let lastPipeline;
let lastFind;

before(() => {
  stub(Job, 'distinct', async () => [JOB_OID]);
  stub(Employee, 'distinct', async () => []);
  // listCallRecords' enrichment: Job.find(...).select(...).limit(...).lean()
  const chain = { select: () => chain, limit: () => chain, populate: () => chain, lean: async () => [] };
  stub(Job, 'find', () => chain);
  stub(CallRecord, 'countDocuments', async (f) => { lastCount = f; return 7; });
  stub(CallRecord, 'aggregate', async (p) => { lastPipeline = p; return [{ _id: 'completed', count: 2 }, { _id: 'failed', count: 1 }]; });
});

after(() => {
  for (const [model, key, fn] of Object.values(saved)) model[key] = fn;
});

/** Swap CallRecord.find for listCallRecords only; the cast helpers need the real one. */
async function listWith(options) {
  const realFind = CallRecord.find;
  const chain = { sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => [] };
  CallRecord.find = (f) => { lastFind = f; return chain; };
  try {
    return await callRecordService.listCallRecords(options);
  } finally {
    CallRecord.find = realFind;
  }
}

describe('callRecord.service Sage filters', () => {
  it('existing listCallRecords options build the same filter as before (no new keys → no new clauses)', async () => {
    await listWith({ isAdmin: true, status: 'completed', callSource: 'telephony' });
    assert.deepEqual(lastFind, { $and: [{ status: 'completed' }, { callSource: 'telephony' }] });
    await listWith({ isAdmin: false, userId: UID, search: 'Priya' });
    assert.equal(lastFind.$and.length, 2, 'search + ownership only');
    assert.deepEqual(lastFind.$and[1].$or.map((c) => Object.keys(c)[0]), ['job', 'candidate', 'createdBy']);
  });

  it('new narrowing options add window, direction, provider, caller and candidate clauses', async () => {
    await listWith({
      isAdmin: true,
      createdFrom: '2026-09-28T18:30:00.000Z',
      createdTo: '2026-09-30T18:29:59.999Z',
      direction: 'inbound',
      provider: 'Twilio',
      createdBy: UID,
      candidateId: CAND,
    });
    const [win, dir, prov, by, cand] = lastFind.$and;
    assert.ok(win.createdAt.$gte instanceof Date && win.createdAt.$lte instanceof Date);
    assert.deepEqual(dir, {
      $or: [
        { 'telephonyData.direction': { $in: ['inbound', 'incoming'] } },
        { 'telephonyData.call_type': { $in: ['inbound', 'incoming'] } },
      ],
    });
    assert.deepEqual(prov, { 'telephonyData.provider': 'twilio' });
    assert.deepEqual(by, { $expr: { $eq: [{ $toString: '$createdBy' }, UID] } }, 'matches legacy string createdBy too');
    assert.equal(String(cand.candidate), CAND);
  });

  it('countCallRecords applies the non-admin scope, cast to ObjectIds / Dates', async () => {
    const n = await callRecordService.countCallRecords({ userId: UID, isAdmin: false, createdFrom: '2026-09-01T00:00:00.000Z' });
    assert.equal(n, 7);
    const scope = lastCount.$and.find((c) => c.$or?.some((o) => 'createdBy' in o));
    const createdBy = scope.$or.find((o) => 'createdBy' in o).createdBy;
    assert.ok(createdBy instanceof mongoose.Types.ObjectId, 'aggregate-safe: createdBy is an ObjectId, not a string');
    assert.ok(lastCount.$and[0].createdAt.$gte instanceof Date);
  });

  it('a malformed candidate id matches nothing instead of everything', async () => {
    await callRecordService.countCallRecords({ isAdmin: true, candidateId: 'not-an-id' });
    assert.deepEqual(lastCount, { candidate: { $in: [] } });
  });

  it('countCallRecords never uses the dialer channel (its ownership runs after dedupe, in JS)', async () => {
    await callRecordService.countCallRecords({ userId: UID, isAdmin: false, channel: 'dialer' });
    const scope = lastCount.$or ? lastCount : lastCount.$and?.find((c) => c.$or);
    assert.ok(scope.$or.some((o) => 'job' in o), 'normal page scope, not the dialer branch');
  });

  it('groupCallRecords groups IST days in Mongo on a cast $match', async () => {
    const out = await callRecordService.groupCallRecords({ userId: UID, isAdmin: false }, { groupBy: 'day', timezone: 'Asia/Kolkata' });
    assert.deepEqual(out, { total: 3, groups: [{ value: 'completed', count: 2 }, { value: 'failed', count: 1 }] });
    const [match, group] = lastPipeline;
    const scope = match.$match.$or || match.$match.$and?.[0]?.$or;
    assert.ok(scope.find((o) => 'createdBy' in o).createdBy instanceof mongoose.Types.ObjectId);
    assert.deepEqual(group.$group._id, { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } });
  });

  it('groupCallRecords by caller merges string and ObjectId createdBy; rejects unknown groupBy', async () => {
    await callRecordService.groupCallRecords({ isAdmin: true }, { groupBy: 'caller' });
    assert.deepEqual(lastPipeline[1].$group._id, { $toString: '$createdBy' });
    await assert.rejects(callRecordService.groupCallRecords({ isAdmin: true }, { groupBy: 'nope' }), /groupBy/);
  });

  it('summarizeCallRecords reads AI answers only when asked', async () => {
    CallRecord.aggregate = async (p) => { lastPipeline = p; return [{ byStatus: [{ _id: 'completed', count: 2 }], completedDuration: [{ avg: 61, count: 2 }] }]; };
    const plain = await callRecordService.summarizeCallRecords({ isAdmin: true });
    assert.equal('interest' in lastPipeline[1].$facet, false);
    assert.deepEqual(plain, { byStatus: { completed: 2 }, avgCompletedDurationSeconds: 61, completedWithDuration: 2 });
    await callRecordService.summarizeCallRecords({ isAdmin: true }, { includeInterest: true });
    assert.ok(lastPipeline[1].$facet.interest);
  });
});
