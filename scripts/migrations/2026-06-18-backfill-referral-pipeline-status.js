/* eslint-disable no-console */
import mongoose from 'mongoose';
import Employee from '../../src/models/employee.model.js';
import config from '../../src/config/config.js';
import { syncReferralPipelineStatusForCandidate } from '../../src/services/referralLeads.service.js';

/**
 * One-time backfill: historical referred candidates carry old-vocab referralPipelineStatus
 * ('hired' / 'in_review' from before the STATUS/STAGE merge). Re-run the single source of truth
 * (syncReferralPipelineStatusForCandidate) for every referred candidate so the stored value matches
 * the new unified vocabulary (interview/offer/preboarding/deferred/joined/employee/resigned).
 *
 * sync is idempotent and is the same write path production events already use — re-running it for a
 * candidate whose status is already correct is a no-op. No dry-run: the only way to know the next
 * value is to run the derivation, which is exactly what sync does.
 *
 * ceiling: O(n) sequential syncs, ~4 reads each. Fine for a one-time job on a referral-lead-sized
 * collection; batch with p-limit if it ever spans tens of thousands.
 */

/* istanbul ignore next */
export const run = async () => {
  /* eslint-disable no-console */
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const candidates = await Employee.find({ referredByUserId: { $ne: null } })
    .select('_id referralPipelineStatus')
    .lean();

  const before = {};
  for (const c of candidates) {
    const k = c.referralPipelineStatus || 'null';
    before[k] = (before[k] || 0) + 1;
  }

  console.log('============================================================');
  console.log(`  Referral pipeline status backfill — ${candidates.length} referred candidates`);
  console.log('  Before:', JSON.stringify(before));
  console.log('============================================================');

  let changed = 0;
  let failed = 0;
  for (const c of candidates) {
    const prev = c.referralPipelineStatus || 'null';
    try {
      await syncReferralPipelineStatusForCandidate(c._id);
      const next = await Employee.findById(c._id).select('referralPipelineStatus').lean();
      if ((next?.referralPipelineStatus || 'null') !== prev) changed += 1;
    } catch (e) {
      failed += 1;
      console.error(`  sync failed for ${c._id}: ${e?.message}`);
    }
  }

  const after = await Employee.aggregate([
    { $match: { referredByUserId: { $ne: null } } },
    { $group: { _id: '$referralPipelineStatus', n: { $sum: 1 } } },
  ]);

  console.log('============================================================');
  console.log(`  Changed: ${changed}   Failed: ${failed}`);
  console.log('  After:', JSON.stringify(Object.fromEntries(after.map((x) => [x._id || 'null', x.n]))));
  console.log('============================================================');

  await mongoose.disconnect();
  return { total: candidates.length, changed, failed };
  /* eslint-enable no-console */
};

/* istanbul ignore next */
if (process.argv[1] && process.argv[1].endsWith('2026-06-18-backfill-referral-pipeline-status.js')) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
