import test from 'node:test';
import assert from 'node:assert/strict';
import { changeSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

function baseCtx(overrides = {}) {
  const current = overrides.current || {
    _id: 'attr1',
    salesAgentUserId: 'u-old',
    isCurrent: true,
    jobId: null,
  };
  const newRow = {
    _id: 'attr2',
    salesAgentUserId: 'u-new',
    assignedAt: new Date(),
    jobId: null,
  };
  return {
    Employee: {
      findById: async () => ({
        _id: 'c1',
        tenantId: 't1',
        referralPipelineStatus: 'applied',
        attributionJobId: null,
      }),
      updateOne: async () => ({ acknowledged: true }),
    },
    User: {
      findById: async () => ({
        _id: 'u-new',
        tenantId: 't1',
        name: 'New Agent',
        email: 'n@x',
        roles: ['sales_agent'],
      }),
    },
    ReferralAttribution: {
      findOne: mockFindOne({ direct: current, onSort: newRow }),
      updateOne: async () => ({ matchedCount: 1 }),
      create: async (rows) => {
        rows[0]._id = 'attr2';
        return [rows[0]];
      },
    },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => fn(null),
  };
}

test('changeSalesAgent supersedes current row and inserts new', async () => {
  const ctx = baseCtx();
  const result = await changeSalesAgent(
    {
      candidateId: 'c1',
      salesAgentUserId: 'u-new',
      expectedCurrentAttributionId: 'attr1',
    },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.equal(result.attribution.salesAgentUserId, 'u-new');
  assert.equal(result.previousAttribution._id, 'attr1');
});

test('rejects when expectedCurrentAttributionId is stale (409 STALE_PRECONDITION)', async () => {
  await assert.rejects(
    changeSalesAgent(
      {
        candidateId: 'c1',
        salesAgentUserId: 'u-new',
        expectedCurrentAttributionId: 'stale',
      },
      { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
      baseCtx()
    ),
    (err) => err.code === 'STALE_PRECONDITION'
  );
});

test('returns current row idempotently if same agent supplied', async () => {
  const current = { _id: 'attr1', salesAgentUserId: 'u-old' };
  const result = await changeSalesAgent(
    {
      candidateId: 'c1',
      salesAgentUserId: 'u-old',
      expectedCurrentAttributionId: 'attr1',
    },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    baseCtx({ current })
  );
  assert.equal(result.attribution._id, 'attr1');
  assert.equal(result.previousAttribution, null);
});
