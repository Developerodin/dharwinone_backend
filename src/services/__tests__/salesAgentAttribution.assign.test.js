import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

function makeCtx(overrides = {}) {
  const stored = [];
  const findOneImpl = overrides.findOne || mockFindOne({ direct: null, onSort: () => stored.at(-1) || null });
  return {
    Employee: {
      findById: async () =>
        overrides.candidate || {
          _id: 'c1',
          tenantId: 't1',
          referralPipelineStatus: 'applied',
          attributionJobId: null,
          joiningDate: null,
          isActive: false,
        },
      updateOne: async () => ({ acknowledged: true }),
    },
    User: {
      findById: async () =>
        overrides.user || {
          _id: 'u1',
          tenantId: 't1',
          name: 'Priya',
          email: 'p@x',
          roles: ['sales_agent'],
        },
    },
    ReferralAttribution: {
      findOne: findOneImpl,
      countDocuments: async (filter) =>
        overrides.countDocuments ? overrides.countDocuments(filter) : 0,
      create: async (rows) => {
        stored.push(rows[0]);
        return [rows[0]];
      },
    },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => fn(null),
    stored,
  };
}

test('assigns when no current attribution exists', async () => {
  const ctx = makeCtx();
  const result = await assignSalesAgent(
    { candidateId: 'c1', salesAgentUserId: 'u1', notes: 'first' },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.equal(result.attribution.salesAgentUserId, 'u1');
  assert.equal(ctx.stored.length, 1);
  assert.equal(ctx.stored[0].source, 'manual_assign');
  assert.equal(ctx.stored[0].salesAgentSnapshot.name, 'Priya');
});

test('returns existing row idempotently when same agent already current', async () => {
  const existing = { _id: 'attr1', salesAgentUserId: 'u1', jobId: 'j1' };
  const updates = [];
  const ctx = makeCtx({
    candidate: {
      _id: 'c1',
      tenantId: 't1',
      referralPipelineStatus: 'applied',
      attributionJobId: 'other-job',
      joiningDate: null,
      isActive: false,
    },
    findOne: mockFindOne({ direct: existing, onSort: existing }),
  });
  ctx.Employee.updateOne = async (_filter, update) => {
    updates.push(update);
    return { acknowledged: true };
  };
  const result = await assignSalesAgent(
    { candidateId: 'c1', salesAgentUserId: 'u1', jobId: 'j1' },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.equal(result.attribution._id, 'attr1');
  assert.equal(ctx.stored.length, 0);
  assert.ok(updates.some((u) => String(u.$set?.currentSalesAgentUserId) === 'u1'));
  assert.ok(updates.some((u) => String(u.$set?.attributionJobId) === 'j1'));
});

test('rejects when different agent is current (409)', async () => {
  const ctx = makeCtx({
    findOne: mockFindOne({ direct: { _id: 'attr1', salesAgentUserId: 'other' } }),
  });
  await assert.rejects(
    assignSalesAgent(
      { candidateId: 'c1', salesAgentUserId: 'u1' },
      { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
      ctx
    ),
    (err) => err.code === 'ATTRIBUTION_EXISTS_USE_PATCH'
  );
});

test('syncs attributionJobId and cache when assigning per-job scope', async () => {
  const jobId = '507f1f77bcf86cd799439011';
  const updates = [];
  const ctx = makeCtx({
    candidate: {
      _id: 'c1',
      tenantId: 't1',
      referralPipelineStatus: 'applied',
      attributionJobId: '507f1f77bcf86cd799439012',
      joiningDate: null,
      isActive: false,
    },
    findOne: mockFindOne({
      direct: null,
      onSort: () => ({
        _id: 'attr-new',
        salesAgentUserId: 'u1',
        jobId,
        assignedAt: new Date('2026-01-01'),
      }),
    }),
  });
  ctx.Job = {
    findById: () => ({
      lean: async () => ({ title: 'Test job', requisitionCode: null }),
    }),
  };
  ctx.Employee.updateOne = async (_filter, update) => {
    updates.push(update);
    return { acknowledged: true };
  };
  await assignSalesAgent(
    { candidateId: 'c1', salesAgentUserId: 'u1', jobId },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.ok(updates.some((u) => String(u.$set?.attributionJobId) === jobId));
  assert.ok(updates.some((u) => String(u.$set?.currentSalesAgentUserId) === 'u1'));
});

test('rejects candidate-level when job-specific rows exist (CANDIDATE_LEVEL_FROZEN)', async () => {
  const ctx = makeCtx({
    countDocuments: async (filter) => (filter.jobId?.$ne === null ? 1 : 0),
    findOne: mockFindOne({ direct: null }),
  });
  await assert.rejects(
    assignSalesAgent(
      { candidateId: 'c1', jobId: null, salesAgentUserId: 'u1' },
      { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
      ctx
    ),
    (err) => err.code === 'CANDIDATE_LEVEL_FROZEN'
  );
});