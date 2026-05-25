import test from 'node:test';
import assert from 'node:assert/strict';
import { recomputeEmployeeCache } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('writes salesAgent fields from lookup result', async () => {
  const updates = [];
  await recomputeEmployeeCache(
    { _id: 'c1', attributionJobId: 'job1' },
    null,
    {
      Employee: {
        updateOne: async (filter, patch) => {
          updates.push(patch);
          return { acknowledged: true };
        },
      },
      ReferralAttribution: {
        findOne: mockFindOne({
          onSort: () => ({
            salesAgentUserId: 'u1',
            assignedAt: new Date('2026-05-25'),
            jobId: 'job1',
          }),
        }),
      },
    }
  );
  assert.equal(updates[0].$set.currentSalesAgentUserId, 'u1');
});

test('writes nulls when lookup returns null', async () => {
  const updates = [];
  await recomputeEmployeeCache(
    { _id: 'c1', attributionJobId: null },
    null,
    {
      Employee: {
        updateOne: async (filter, patch) => {
          updates.push(patch);
          return { acknowledged: true };
        },
      },
      ReferralAttribution: {
        findOne: mockFindOne({ onSort: null }),
      },
    }
  );
  assert.equal(updates[0].$set.currentSalesAgentUserId, null);
});
