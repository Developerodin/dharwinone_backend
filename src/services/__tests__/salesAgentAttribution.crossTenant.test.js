import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('blocks cross-tenant assignment', async () => {
  const ctx = {
    Employee: {
      findById: async () => ({ _id: 'c1', tenantId: 'tenant-a', attributionJobId: null }),
      updateOne: async () => ({ acknowledged: true }),
    },
    User: {
      findById: async () => ({ _id: 'u1', tenantId: 'tenant-b', roles: ['sales_agent'], name: 'A', email: 'a@x' }),
    },
    ReferralAttribution: {
      findOne: mockFindOne({ direct: null }),
      countDocuments: async () => 0,
      create: async (rows) => [rows[0]],
    },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => fn(null),
  };
  await assert.rejects(
    assignSalesAgent(
      { candidateId: 'c1', salesAgentUserId: 'u1' },
      { actor: { _id: 'admin1', tenantId: 'tenant-a', roles: ['Administrator'] } },
      ctx
    ),
    (err) => err.code === 'CROSS_TENANT_ASSIGNMENT_FORBIDDEN'
  );
});

test('blocks future assignedAt', async () => {
  const ctx = {
    Employee: {
      findById: async () => ({ _id: 'c1', tenantId: 't1', attributionJobId: null }),
      updateOne: async () => ({ acknowledged: true }),
    },
    User: {
      findById: async () => ({ _id: 'u1', tenantId: 't1', roles: ['sales_agent'], name: 'A', email: 'a@x' }),
    },
    ReferralAttribution: { findOne: mockFindOne({ direct: null }), countDocuments: async () => 0 },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => fn(null),
  };
  await assert.rejects(
    assignSalesAgent(
      {
        candidateId: 'c1',
        salesAgentUserId: 'u1',
        assignedAt: new Date(Date.now() + 86400000).toISOString(),
      },
      { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
      ctx
    ),
    /ASSIGN_DATE_IN_FUTURE|Assignment date cannot be in the future/
  );
});
