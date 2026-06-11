import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildReferralLeadsMatch } from '../referralLeads.service.js';

test('scoped view surfaces leads referred-by-me OR sales-agent-is-me', async () => {
  const user = { _id: new mongoose.Types.ObjectId() };
  const mongo = await buildReferralLeadsMatch({ user, canSeeAll: false, query: {} });

  // Base constraint: only actual referral leads are listed.
  assert.deepEqual(mongo.referredByUserId, { $exists: true, $ne: null });

  // Scoping is an $or over referrer and assigned sales agent.
  const orClause = (mongo.$and || []).find((c) => Array.isArray(c.$or));
  assert.ok(orClause, 'expected an $or scoping clause');
  const referrer = orClause.$or.find((c) => c.referredByUserId);
  const salesAgent = orClause.$or.find((c) => c.currentSalesAgentUserId);
  assert.equal(String(referrer.referredByUserId), String(user._id));
  assert.equal(String(salesAgent.currentSalesAgentUserId), String(user._id));
});

test('admin view (canSeeAll) is not self-scoped', async () => {
  const user = { _id: new mongoose.Types.ObjectId() };
  const mongo = await buildReferralLeadsMatch({ user, canSeeAll: true, query: {} });
  assert.deepEqual(mongo.referredByUserId, { $exists: true, $ne: null });
  assert.equal(mongo.$and, undefined);
});
