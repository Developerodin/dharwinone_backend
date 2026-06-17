import mongoose from 'mongoose';
import Placement from '../../src/models/placement.model.js';
import config from '../../src/config/config.js';

/**
 * Repair placements orphaned by the legacy re-accept bug.
 *
 * Old code, on re-accepting a Cancelled offer, ran `$unset: { offer }` on the existing Cancelled
 * placement and created a SECOND placement holding the offer. That left the old doc with
 * `offer === null` (which violates the schema's `required: true`) plus a `_cancelledOfferRef`
 * tombstone. Any later `placement.save()` on the orphan threw
 * `Placement validation failed: offer: Path 'offer' is required.`
 *
 * Repair rule (pure):
 *   - orphan whose `_cancelledOfferRef` offer is ALREADY held by another placement
 *       → the orphan is the abandoned duplicate → DELETE it.
 *   - orphan whose `_cancelledOfferRef` offer is free (no other placement holds it)
 *       → RE-LINK: set `offer = _cancelledOfferRef`, drop the tombstone (offer never got a sibling).
 *   - orphan with no `_cancelledOfferRef` → UNRECOVERABLE → leave for manual review.
 *
 * @param {Array<{_id:any,_cancelledOfferRef:any}>} orphans - placements with no `offer`
 * @param {Iterable<string>} heldOfferIds - offer ids held by a non-orphan placement (stringified)
 * @returns {{toDelete:any[], toRelink:Array<{_id:any,offer:any}>, unrecoverable:any[]}}
 */
export const planOrphanRepair = (orphans, heldOfferIds) => {
  const held = new Set([...(heldOfferIds || [])].map(String));
  const toDelete = [];
  const toRelink = [];
  const unrecoverable = [];
  for (const o of orphans || []) {
    const ref = o._cancelledOfferRef ? String(o._cancelledOfferRef) : null;
    if (!ref) {
      unrecoverable.push(o._id);
    } else if (held.has(ref)) {
      toDelete.push(o._id);
    } else {
      toRelink.push({ _id: o._id, offer: o._cancelledOfferRef });
    }
  }
  return { toDelete, toRelink, unrecoverable };
};

/* istanbul ignore next */
const printReport = (plan, { dryRun }) => {
  const total = plan.toDelete.length + plan.toRelink.length + plan.unrecoverable.length;
  /* eslint-disable no-console */
  console.log('============================================================');
  console.log(`  Orphaned Placement repair — ${dryRun ? 'DRY RUN (no writes)' : 'LIVE RUN'}`);
  console.log('============================================================');
  console.log(`  Total placements affected      : ${total}`);
  console.log(`  To be deleted (abandoned dup)  : ${plan.toDelete.length}`);
  if (plan.toDelete.length) console.log(`      ids: ${plan.toDelete.map(String).join(', ')}`);
  console.log(`  To be relinked (offer freed)   : ${plan.toRelink.length}`);
  for (const r of plan.toRelink) console.log(`      ${String(r._id)}  ->  offer ${String(r.offer)}`);
  console.log(`  Unrecoverable (manual review)  : ${plan.unrecoverable.length}`);
  if (plan.unrecoverable.length) console.log(`      ids: ${plan.unrecoverable.map(String).join(', ')}`);
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

  const orphans = await Placement.find({ $or: [{ offer: null }, { offer: { $exists: false } }] })
    .select('_id _cancelledOfferRef')
    .lean();
  const held = await Placement.find({ offer: { $exists: true, $ne: null } })
    .select('offer')
    .lean();
  const heldOfferIds = held.map((p) => String(p.offer));

  const plan = planOrphanRepair(orphans, heldOfferIds);

  if (!dryRun) {
    for (const id of plan.toDelete) {
      await Placement.deleteOne({ _id: id });
    }
    for (const r of plan.toRelink) {
      await Placement.updateOne({ _id: r._id }, { $set: { offer: r.offer }, $unset: { _cancelledOfferRef: 1 } });
    }
  }

  printReport(plan, { dryRun });

  await mongoose.disconnect();
  return plan;
};

/* istanbul ignore next */
if (process.argv[1] && process.argv[1].endsWith('2026-06-17-fix-orphaned-cancelled-placements.js')) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
