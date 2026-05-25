import test from 'node:test';
import assert from 'node:assert/strict';
import { getSalesAgentHistory, pinAttributionJob } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('getSalesAgentHistory returns mapped rows', async () => {
  const rows = [
    {
      _id: 'a2',
      assignedAt: new Date('2026-05-25'),
      salesAgentUserId: { _id: 'u1', name: 'A', email: 'a@x' },
      assignedByUserId: { _id: 'admin', name: 'Admin', email: 'admin@x' },
      jobId: null,
      salesAgentSnapshot: { name: 'A', email: 'a@x' },
      lifecycleStageAtAssignment: 'applied',
      notes: null,
      source: 'manual_assign',
      isCurrent: true,
      isRevoked: false,
      revokeReason: null,
      previousAttributionId: null,
    },
  ];
  const ctx = {
    Employee: { findById: async () => ({ _id: 'c1' }) },
    ReferralAttribution: {
      find: () => ({
        sort: () => ({
          limit: () => ({
            populate: () => ({
              populate: () => ({
                populate: () => ({ lean: async () => rows }),
              }),
            }),
          }),
        }),
      }),
    },
  };
  const { results, hasMore } = await getSalesAgentHistory('c1', {}, ctx);
  assert.equal(results.length, 1);
  assert.equal(results[0].salesAgent.name, 'A');
  assert.equal(hasMore, false);
});

test('pinAttributionJob writes attributionJobId', async () => {
  const updates = [];
  const ctx = {
    Employee: {
      findById: async () => ({ _id: 'c1', tenantId: 't1', attributionJobId: null }),
      updateOne: async (filter, patch) => {
        updates.push(patch);
        return { acknowledged: true };
      },
    },
    Job: { findById: async () => ({ _id: 'job1', title: 'Engineer' }) },
    JobApplication: { exists: async () => true },
    ReferralAttribution: {
      findOne: mockFindOne({ onSort: null }),
    },
    ActivityLog: { create: async () => null },
  };
  await pinAttributionJob(
    { candidateId: 'c1', jobId: 'job1', reason: 'primary hire job' },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.equal(updates[0].$set.attributionJobId, 'job1');
});
