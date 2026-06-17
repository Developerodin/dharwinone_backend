import mongoose from 'mongoose';
import Placement from '../../src/models/placement.model.js';
import Offer from '../../src/models/offer.model.js';
import config from '../../src/config/config.js';

/**
 * Reconcile placements left active after their offer was rejected.
 *
 * The forward cascade (Offer Rejected → Placement Cancelled) was added in offer.service.js, but
 * older rejections happened before it existed, so some placements still sit in an active state
 * (Pending / Onboarding / Deferred) under a Rejected offer. This one-shot script cancels those.
 *
 * Deliberately one-directional and conservative:
 *   - placement.offer is a Rejected offer AND status ∈ {Pending, Onboarding, Deferred} → CANCEL.
 *   - Joined → SKIP (the hire already started; lifecycle forbids Joined → Cancelled).
 *   - already Cancelled → SKIP (no-op).
 * It never touches Offer.status — an Accepted offer + Cancelled placement stays a legitimate state.
 *
 * Pure planner is exported for tests; `run()` does the IO.
 */

export const CANCELLABLE_STATUSES = ['Pending', 'Onboarding', 'Deferred'];

/**
 * @param {Array<{_id:any, offer:any, status:string}>} placements - placements linked to a Rejected offer
 * @returns {{toCancel:any[], skippedJoined:any[], skippedCancelled:any[]}}
 */
export const planRejectedOfferReconcile = (placements) => {
  const toCancel = [];
  const skippedJoined = [];
  const skippedCancelled = [];
  for (const p of placements || []) {
    if (CANCELLABLE_STATUSES.includes(p.status)) {
      toCancel.push(p._id);
    } else if (p.status === 'Joined') {
      skippedJoined.push(p._id);
    } else if (p.status === 'Cancelled') {
      skippedCancelled.push(p._id);
    }
  }
  return { toCancel, skippedJoined, skippedCancelled };
};

/* istanbul ignore next */
const printReport = (plan, { dryRun }) => {
  /* eslint-disable no-console */
  console.log('============================================================');
  console.log(`  Rejected-offer placement reconcile — ${dryRun ? 'DRY RUN (no writes)' : 'LIVE RUN'}`);
  console.log('============================================================');
  console.log(`  To be cancelled (active under rejected offer): ${plan.toCancel.length}`);
  if (plan.toCancel.length) console.log(`      ids: ${plan.toCancel.map(String).join(', ')}`);
  console.log(`  Skipped — already Joined   : ${plan.skippedJoined.length}`);
  if (plan.skippedJoined.length) console.log(`      ids: ${plan.skippedJoined.map(String).join(', ')}`);
  console.log(`  Skipped — already Cancelled: ${plan.skippedCancelled.length}`);
  console.log('============================================================');
  if (dryRun) console.log('  DRY RUN — nothing was written. Re-run without --dry-run to apply.');
  /* eslint-enable no-console */
};

/**
 * @param {{dryRun?: boolean}} [opts]
 */
/* istanbul ignore next */
export const run = async ({ dryRun = false } = {}) => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const rejectedOfferIds = (await Offer.find({ status: 'Rejected' }).select('_id').lean()).map((o) => o._id);
  const placements = await Placement.find({ offer: { $in: rejectedOfferIds } })
    .select('_id offer status')
    .lean();

  const plan = planRejectedOfferReconcile(placements);

  if (!dryRun && plan.toCancel.length) {
    // System reconcile: cancelledBy null (no human actor); cancelledAt stamps when the repair ran.
    await Placement.updateMany(
      { _id: { $in: plan.toCancel } },
      { $set: { status: 'Cancelled', cancelledBy: null, cancelledAt: new Date() } }
    );
  }

  printReport(plan, { dryRun });

  await mongoose.disconnect();
  return plan;
};

/* istanbul ignore next */
if (process.argv[1] && process.argv[1].endsWith('2026-06-17-cascade-rejected-offers-to-placements.js')) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
