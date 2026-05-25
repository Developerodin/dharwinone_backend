import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('rolls back when recompute fails inside transaction', async () => {
  let created = false;
  const ctx = {
    Employee: {
      findById: async () => ({ _id: 'c1', tenantId: 't1', attributionJobId: null }),
      updateOne: async () => {
        throw new Error('cache write failed');
      },
    },
    User: {
      findById: async () => ({ _id: 'u1', tenantId: 't1', roles: ['sales_agent'], name: 'A', email: 'a@x' }),
    },
    ReferralAttribution: {
      findOne: mockFindOne({ direct: null }),
      countDocuments: async () => 0,
      create: async () => {
        created = true;
        return [{ _id: 'a1' }];
      },
    },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => {
      const session = {};
      await fn(session);
    },
  };
  await assert.rejects(
    assignSalesAgent(
      { candidateId: 'c1', salesAgentUserId: 'u1' },
      { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
      ctx
    ),
    /cache write failed/
  );
  assert.equal(created, true);
});
