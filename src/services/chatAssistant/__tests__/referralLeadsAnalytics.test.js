import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERRAL_LEADS_READ_PERMISSION,
  hasReferralLeadsReadAccess,
  buildSyntheticReferralReq,
  labelHiringTunnelBuckets,
  PRE_BOARDING_PROVENANCE,
} from '../referralLeadsAnalytics.js';

describe('referralLeadsAnalytics (Epic C)', () => {
  it('exposes the same permission the referral-leads HTTP routes require', () => {
    assert.equal(REFERRAL_LEADS_READ_PERMISSION, 'candidates.read');
  });

  it('grants access only when the permission Set carries candidates.read (or an alias)', () => {
    assert.equal(hasReferralLeadsReadAccess(new Set(['candidates.read'])), true);
    assert.equal(hasReferralLeadsReadAccess(new Set(['employees.read'])), false);
    assert.equal(hasReferralLeadsReadAccess(new Set()), false);
    assert.equal(hasReferralLeadsReadAccess(null), false);
    assert.equal(hasReferralLeadsReadAccess(undefined), false);
  });

  it('builds a synthetic req using an explicitly passed permission Set (no DB call)', async () => {
    const user = { _id: 'u1' };
    const perms = new Set(['candidates.read']);
    const req = await buildSyntheticReferralReq(user, { from: '2026-07-01' }, perms);
    assert.equal(req.user, user);
    assert.deepEqual(req.query, { from: '2026-07-01' });
    assert.equal(req.authContext.permissions, perms);
  });

  it('reuses user.authContext.permissions when already populated (auth() middleware parity)', async () => {
    const perms = new Set(['candidates.read']);
    const user = { _id: 'u2', authContext: { isAdmin: false, permissions: perms } };
    const req = await buildSyntheticReferralReq(user, {});
    assert.equal(req.authContext, user.authContext);
    assert.equal(req.authContext.permissions, perms);
  });

  it('defaults to an empty query object when none is passed', async () => {
    const req = await buildSyntheticReferralReq({ _id: 'u3' }, undefined, new Set());
    assert.deepEqual(req.query, {});
  });

  it('labels hiring-tunnel buckets from a getReferralLeadsStats-shaped result', () => {
    const stats = {
      totalReferrals: 100,
      pipelineCounts: {
        pending: 10,
        profile_complete: 5,
        applied: 20,
        interview: 15,
        offer: 8,
        hired: 6,
        joined: 4,
        deferred: 1,
        preboarding: 7,
        employee: 12,
        resigned: 2,
        rejected: 9,
        job_removed: 1,
      },
    };
    const buckets = labelHiringTunnelBuckets(stats);

    assert.equal(buckets.refer_leads.count, 100);
    assert.equal(buckets.refer_leads.source, 'getReferralLeadsStats.totalReferrals');

    assert.equal(buckets.applications.count, 20);
    assert.equal(buckets.interviews.count, 15);
    assert.equal(buckets.offers.count, 8);

    // placements = hired(Onboarding) + joined(Joined) + deferred(Deferred)
    assert.equal(buckets.placements.count, 6 + 4 + 1);

    // pre_boarding must be flagged concurrent — not a linear APPLICATION_STATUSES step.
    assert.equal(buckets.pre_boarding.count, 7);
    assert.equal(buckets.pre_boarding.concurrent, true);

    assert.equal(buckets.onboarded.count, 12);
  });

  it('sums interview + legacy in_review alias defensively', () => {
    const buckets = labelHiringTunnelBuckets({
      totalReferrals: 1,
      pipelineCounts: { interview: 3, in_review: 2 },
    });
    assert.equal(buckets.interviews.count, 5);
  });

  it('treats missing pipelineCounts as all-zero buckets (no throw)', () => {
    const buckets = labelHiringTunnelBuckets({});
    assert.equal(buckets.refer_leads.count, 0);
    assert.equal(buckets.applications.count, 0);
    assert.equal(buckets.pre_boarding.count, 0);
  });

  it('documents pre-boarding provenance as concurrent and non-linear', () => {
    assert.equal(PRE_BOARDING_PROVENANCE.source, 'Placement.preBoardingStatus');
    assert.equal(PRE_BOARDING_PROVENANCE.concurrent, true);
    assert.equal(PRE_BOARDING_PROVENANCE.linearApplicationStep, false);
  });
});
