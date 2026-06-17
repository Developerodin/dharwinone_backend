import mongoose from 'mongoose';
import Placement from '../../src/models/placement.model.js';
import Offer from '../../src/models/offer.model.js';
import config from '../../src/config/config.js';

/**
 * Backfill the two new denormalized/stage fields on existing placements:
 *   - offerStatus        ← mirror of the linked Offer.status (queues filter on 'Accepted').
 *   - enteredOnboardingAt← stage discriminator. New writes stamp it on →Onboarding, but historical
 *                          rows predate that, so we infer it from existing onboarding artifacts.
 *
 * enteredOnboardingAt inference (only when not already set):
 *   status Onboarding/Joined         → onboarding reached  (joinedAt ?? onboardingCompletedAt ?? updatedAt)
 *   else joinedAt present            → joinedAt
 *   else onboardingCompletedAt set   → onboardingCompletedAt
 *   else onboardingTasks non-empty   → updatedAt
 *   else                             → null (treated as Pre-Boarding)
 *
 * ceiling: a historical Deferred/Cancelled that sat in Onboarding but left NO onboarding artifact
 * (no joinedAt / completedAt / tasks) infers null → shows in Pre-Boarding. Unrecoverable from data;
 * recruiter can Move-to-Onboarding again. Logged in the report as `ambiguousOfframp`.
 *
 * Pure planner is exported for tests; `run()` does the IO.
 */

const ONBOARDING_REACHED = new Set(['Onboarding', 'Joined']);
const OFFRAMP = new Set(['Deferred', 'Cancelled']);

/**
 * @param {Array<object>} placements - {_id, offer, offerStatus, status, joinedAt, onboardingCompletedAt,
 *                                      onboardingTasksCount, updatedAt, enteredOnboardingAt}
 * @param {Record<string,string>} offerStatusById - offerId(string) → Offer.status
 * @returns {{updates:Array<{_id:any,set:object}>, ambiguousOfframp:any[], orphans:any[]}}
 */
export const planPlacementBackfill = (placements, offerStatusById = {}) => {
  const updates = [];
  const ambiguousOfframp = [];
  const orphans = [];

  for (const p of placements || []) {
    const set = {};
    const offerKey = p.offer ? String(p.offer) : null;
    const offerStatus = offerKey ? offerStatusById[offerKey] : undefined;

    if (!offerKey) orphans.push(p._id);
    else if (offerStatus && p.offerStatus !== offerStatus) set.offerStatus = offerStatus;

    if (!p.enteredOnboardingAt) {
      let entered = null;
      if (ONBOARDING_REACHED.has(p.status)) {
        entered = p.joinedAt ?? p.onboardingCompletedAt ?? p.updatedAt ?? null;
      } else if (p.joinedAt) {
        entered = p.joinedAt;
      } else if (p.onboardingCompletedAt) {
        entered = p.onboardingCompletedAt;
      } else if (p.onboardingTasksCount > 0) {
        entered = p.updatedAt ?? null;
      } else if (OFFRAMP.has(p.status)) {
        // Off-ramp with no onboarding footprint → can't tell which stage it was applied in.
        ambiguousOfframp.push(p._id);
      }
      if (entered) set.enteredOnboardingAt = entered;
    }

    if (Object.keys(set).length) updates.push({ _id: p._id, set });
  }

  return { updates, ambiguousOfframp, orphans };
};

/* istanbul ignore next */
const printReport = (plan, { dryRun }) => {
  /* eslint-disable no-console */
  console.log('============================================================');
  console.log(`  Placement offerStatus/stage backfill — ${dryRun ? 'DRY RUN (no writes)' : 'LIVE RUN'}`);
  console.log('============================================================');
  console.log(`  Placements to update             : ${plan.updates.length}`);
  console.log(`  Ambiguous off-ramp (→PreBoarding): ${plan.ambiguousOfframp.length}`);
  if (plan.ambiguousOfframp.length) console.log(`      ids: ${plan.ambiguousOfframp.map(String).join(', ')}`);
  console.log(`  Orphans (no offer, skipped)      : ${plan.orphans.length}`);
  console.log('============================================================');
  if (dryRun) console.log('  DRY RUN — nothing was written. Re-run without --dry-run to apply.');
  /* eslint-enable no-console */
};

/* istanbul ignore next */
export const run = async ({ dryRun = false } = {}) => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const placements = await Placement.find({})
    .select('_id offer offerStatus status joinedAt onboardingCompletedAt onboardingTasks enteredOnboardingAt updatedAt')
    .lean();

  const offerIds = [...new Set(placements.map((p) => p.offer).filter(Boolean).map(String))];
  const offers = await Offer.find({ _id: { $in: offerIds } }).select('_id status').lean();
  const offerStatusById = Object.fromEntries(offers.map((o) => [String(o._id), o.status]));

  const shaped = placements.map((p) => ({
    _id: p._id,
    offer: p.offer,
    offerStatus: p.offerStatus,
    status: p.status,
    joinedAt: p.joinedAt,
    onboardingCompletedAt: p.onboardingCompletedAt,
    onboardingTasksCount: Array.isArray(p.onboardingTasks) ? p.onboardingTasks.length : 0,
    updatedAt: p.updatedAt,
    enteredOnboardingAt: p.enteredOnboardingAt,
  }));

  const plan = planPlacementBackfill(shaped, offerStatusById);

  if (!dryRun && plan.updates.length) {
    await Placement.bulkWrite(
      plan.updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: u.set } } }))
    );
  }

  printReport(plan, { dryRun });

  await mongoose.disconnect();
  return plan;
};

/* istanbul ignore next */
if (process.argv[1] && process.argv[1].endsWith('2026-06-17-backfill-placement-offerstatus-stage.js')) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
