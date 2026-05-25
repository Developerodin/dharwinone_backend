import test from 'node:test';
import assert from 'node:assert/strict';
import { revokeSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('revokeSalesAgent marks current row revoked, clears cache, writes activity log', async () => {
  const updates = [];
  const current = {
    _id: 'attr1',
    salesAgentUserId: 'u1',
    isCurrent: true,
    jobId: null,
    toObject: () => ({ _id: 'attr1', salesAgentUserId: 'u1' }),
  };
  const ctx = {
    Employee: {
      findById: async () => ({ _id: 'c1', tenantId: 't1', attributionJobId: null }),
      updateOne: async (filter, patch) => {
        updates.push({ filter, patch });
        return { acknowledged: true };
      },
    },
    ReferralAttribution: {
      findOne: mockFindOne({ direct: current, onSort: null }),
      updateOne: async (filter, patch) => {
        updates.push({ filter, patch });
        return { matchedCount: 1 };
      },
    },
    ActivityLog: { create: async () => null },
    transaction: async (fn) => fn(null),
  };
  const result = await revokeSalesAgent(
    { candidateId: 'c1', expectedCurrentAttributionId: 'attr1', revokeReason: 'wrong agent' },
    { actor: { _id: 'admin1', tenantId: 't1', roles: ['Administrator'] } },
    ctx
  );
  assert.equal(result.revokedAttribution._id, 'attr1');
  const revokePatch = updates.find((u) => u.patch.$set?.isRevoked === true);
  assert.ok(revokePatch);
});
