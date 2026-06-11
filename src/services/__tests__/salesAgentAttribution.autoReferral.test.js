import test from 'node:test';
import assert from 'node:assert/strict';
import { autoAttributeReferrerAsSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('skips when the referrer is not a sales agent', async () => {
  let created = 0;
  const res = await autoAttributeReferrerAsSalesAgent({ _id: 'c1', tenantId: 't1' }, 'u1', null, {
    User: { findById: async () => ({ _id: 'u1', name: 'Referrer' }) },
    isSalesAgent: async () => false,
    ReferralAttribution: {
      findOne: mockFindOne({ direct: null }),
      create: async () => {
        created += 1;
        return [{ _id: 'new' }];
      },
    },
    Employee: { updateOne: async () => ({ acknowledged: true }) },
  });
  assert.equal(res.auto, false);
  assert.equal(res.reason, 'not_sales_agent');
  assert.equal(created, 0);
});

test('skips when a current attribution already exists (idempotent)', async () => {
  let created = 0;
  const res = await autoAttributeReferrerAsSalesAgent({ _id: 'c1', tenantId: 't1' }, 'u1', null, {
    User: { findById: async () => ({ _id: 'u1' }) },
    isSalesAgent: async () => true,
    ReferralAttribution: {
      findOne: mockFindOne({ direct: { _id: 'existing' } }),
      create: async () => {
        created += 1;
        return [{ _id: 'new' }];
      },
    },
    Employee: { updateOne: async () => ({ acknowledged: true }) },
  });
  assert.equal(res.auto, false);
  assert.equal(res.reason, 'attribution_exists');
  assert.equal(created, 0);
});

test('returns missing_input when candidate or referrer is absent', async () => {
  const a = await autoAttributeReferrerAsSalesAgent(null, 'u1', null, { isSalesAgent: async () => true });
  const b = await autoAttributeReferrerAsSalesAgent({ _id: 'c1' }, null, null, { isSalesAgent: async () => true });
  assert.equal(a.reason, 'missing_input');
  assert.equal(b.reason, 'missing_input');
});
