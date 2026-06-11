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

// Regression: inside a transaction, the attribution row is inserted with the
// session and is invisible to reads that omit it. recomputeEmployeeCache must
// bind the same session to its ReferralAttribution reads, or it caches a stale
// null and the lead renders "Unassigned" right after a successful assign.
test('threads the transaction session into the ReferralAttribution reads', async () => {
  const seenSessions = [];
  const session = { id: 'txn-session' };
  await recomputeEmployeeCache(
    { _id: 'c1', attributionJobId: 'job1' },
    session,
    {
      Employee: {
        updateOne: async () => ({ acknowledged: true }),
      },
      ReferralAttribution: {
        findOne: mockFindOne({
          onSort: () => ({
            salesAgentUserId: 'u1',
            assignedAt: new Date('2026-05-25'),
            jobId: 'job1',
          }),
          onSession: (s) => seenSessions.push(s),
        }),
      },
    }
  );
  assert.ok(seenSessions.length > 0, '.session() was never called on the read');
  assert.equal(seenSessions[0], session);
});
