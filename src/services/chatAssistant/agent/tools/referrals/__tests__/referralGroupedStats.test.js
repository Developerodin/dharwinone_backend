// referralLeads.service getReferralLeadsStatsByAgent / getReferralOpenStageAges — the grouped calls
// get_referral_stats ranks and ages leads with. No database: Employee.aggregate is swapped for a recorder.
// roleIds: [] keeps userIsSalesAgent off the Role collection.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import mongoose from 'mongoose';
import Employee from '../../../../../../models/employee.model.js';
import {
  getReferralLeadsStatsByAgent,
  getReferralOpenStageAges,
  REFERRAL_OPEN_STAGES,
} from '../../../../../referralLeads.service.js';

const ME = new mongoose.Types.ObjectId();
const AGENT = new mongoose.Types.ObjectId();
const req = (perms, query = {}) => ({ user: { _id: ME, roleIds: [] }, authContext: { permissions: new Set(perms) }, query });

function contains(v, clause) {
  if (isDeepStrictEqual(v, clause)) return true;
  if (Array.isArray(v)) return v.some((x) => contains(x, clause));
  if (v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId) && !(v instanceof Date)) {
    return Object.values(v).some((x) => contains(x, clause));
  }
  return false;
}

let pipelines = [];
let rows = [];
let saved;
before(() => {
  saved = Employee.aggregate;
  Employee.aggregate = async (p) => { pipelines.push(p); return rows; };
});
after(() => { Employee.aggregate = saved; });

describe('getReferralLeadsStatsByAgent', () => {
  it('a scoped viewer only aggregates leads they referred or are the sales agent for', async () => {
    pipelines = [];
    rows = [];
    await getReferralLeadsStatsByAgent(req(['candidates.read']));
    const match = pipelines[0][0].$match;
    assert.ok(contains(match, { $or: [{ referredByUserId: ME }, { currentSalesAgentUserId: ME }] }));
  });

  it('an org-wide viewer can filter to one sales agent and the window', async () => {
    pipelines = [];
    await getReferralLeadsStatsByAgent(req(['candidates.manage'], { salesAgentUserId: String(AGENT), from: '2026-09-01T00:00:00.000Z' }));
    const match = pipelines[0][0].$match;
    assert.equal(String(match.currentSalesAgentUserId), String(AGENT));
    assert.ok(match.referredAt.$gte instanceof Date);
    assert.equal(match.$and, undefined, 'no self-scope for an org-wide viewer');
  });

  it('groups by agent and effective status; conversion and average days match the page formulas', async () => {
    rows = [
      { _id: { agent: AGENT, status: 'applied' }, c: 2, joinDaysSum: 0, joinDaysN: 0 },
      { _id: { agent: AGENT, status: 'employee' }, c: 2, joinDaysSum: 25, joinDaysN: 2 },
      { _id: { agent: AGENT, status: 'pending' }, c: 1, joinDaysSum: 0, joinDaysN: 0 },
      { _id: { agent: null, status: 'pending' }, c: 3, joinDaysSum: 0, joinDaysN: 0 },
    ];
    const out = await getReferralLeadsStatsByAgent(req(['candidates.manage']));
    const agent = out.find((g) => g.salesAgentUserId === String(AGENT));
    assert.deepEqual(agent, {
      salesAgentUserId: String(AGENT),
      totalReferrals: 5,
      pipelineCounts: { applied: 2, employee: 2, pending: 1 },
      conversionRate: 80, // applied + employee are converted statuses: 4 / 5
      avgReferralToJoiningDays: 12.5,
      joinedWithDates: 2,
    });
    const unassigned = out.find((g) => g.salesAgentUserId === null);
    assert.equal(unassigned.conversionRate, 0);
    assert.equal(unassigned.avgReferralToJoiningDays, null);
    const group = pipelines.at(-1).find((s) => s.$group).$group;
    assert.deepEqual(group._id.agent, { $ifNull: ['$currentSalesAgentUserId', null] });
    rows = [];
  });

  it('groupBySalesAgent false puts the whole scope in one group', async () => {
    pipelines = [];
    await getReferralLeadsStatsByAgent(req(['candidates.read']), { groupBySalesAgent: false });
    const group = pipelines[0].find((s) => s.$group).$group;
    assert.deepEqual(group._id.agent, { $literal: null });
  });

  it('the join-days expression only counts joined leads whose join date is not before the referral', async () => {
    pipelines = [];
    await getReferralLeadsStatsByAgent(req(['candidates.manage']));
    const cond = pipelines[0].find((s) => s.$group).$group.joinDaysSum.$sum.$cond[0].$and;
    assert.ok(contains(cond, { $gte: ['$joiningDate', '$referredAt'] }));
    assert.ok(contains(cond, { $eq: [{ $type: '$referredAt' }, 'date'] }));
  });
});

describe('getReferralOpenStageAges', () => {
  it('ages only the open stages, scoped like the page, and rounds the result', async () => {
    pipelines = [];
    rows = [
      { _id: 'offer', count: 2, withDate: 1, avgDays: 12.345, oldestDays: 12.9 },
      { _id: 'interview', count: 3, withDate: 0, avgDays: null, oldestDays: null },
    ];
    const out = await getReferralOpenStageAges(req(['candidates.read']));
    assert.deepEqual(out, {
      offer: { count: 2, withDate: 1, avgDays: 12.3, oldestDays: 12.9 },
      interview: { count: 3, withDate: 0, avgDays: null, oldestDays: null },
    });
    const p = pipelines[0];
    assert.ok(contains(p[0].$match, { $or: [{ referredByUserId: ME }, { currentSalesAgentUserId: ME }] }));
    assert.ok(p.some((s) => isDeepStrictEqual(s, { $match: { effectiveStatus: { $in: REFERRAL_OPEN_STAGES } } })));
    const lookups = p.filter((s) => s.$lookup).map((s) => s.$lookup.as);
    for (const as of ['_apps', '_offers', '_placements', '_meetings']) assert.ok(lookups.includes(as), as);
    rows = [];
  });
});
