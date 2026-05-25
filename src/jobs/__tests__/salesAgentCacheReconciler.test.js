import test from 'node:test';
import assert from 'node:assert/strict';
import { runReconciler } from '../salesAgentCacheReconciler.job.js';
import { mockFindOne } from '../../services/__tests__/helpers/mockMongooseQuery.js';

test('reconciles drifted Employee.currentSalesAgentUserId', async () => {
  const updates = [];
  const emp = { _id: 'e1', tenantId: 't1', attributionJobId: null, currentSalesAgentUserId: 'wrong' };
  const Employee = {
    find: () => ({
      cursor: async function* gen() {
        yield emp;
      },
    }),
    updateOne: async (filter, patch) => {
      updates.push({ filter, patch });
      return { acknowledged: true };
    },
  };
  const ReferralAttribution = {
    findOne: mockFindOne({
      onSort: () => ({
        salesAgentUserId: 'expected',
        assignedAt: new Date('2026-05-20'),
        jobId: null,
      }),
    }),
  };
  const result = await runReconciler({ Employee, ReferralAttribution, ActivityLog: null });
  assert.equal(result.driftCount, 1);
  assert.equal(updates[0].patch.$set.currentSalesAgentUserId, 'expected');
});

test('warns at DRIFT_THRESHOLD.WARN threshold in dry run', async () => {
  const employees = Array.from({ length: 11 }, (_, i) => ({
    _id: `e${i}`,
    tenantId: 't1',
    attributionJobId: null,
    currentSalesAgentUserId: 'wrong',
  }));
  const Employee = {
    find: () => ({
      cursor: async function* gen() {
        for (const e of employees) yield e;
      },
    }),
    updateOne: async () => ({ acknowledged: true }),
  };
  const ReferralAttribution = {
    findOne: mockFindOne({
      onSort: () => ({ salesAgentUserId: 'expected', assignedAt: new Date(), jobId: null }),
    }),
  };
  const result = await runReconciler({ Employee, ReferralAttribution, ActivityLog: null, dryRun: true });
  assert.equal(result.driftCount, 11);
});
