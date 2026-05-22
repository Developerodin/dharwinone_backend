/* One-time backfill: populate compensationType on pre-existing Offers and Employees.
 * Run: node src/scripts/backfillCompensationType.js        (apply)
 *      node src/scripts/backfillCompensationType.js --dry   (preview only) */
import mongoose from 'mongoose';
import config from '../config/config.js';
import Offer from '../models/offer.model.js';
import Employee from '../models/employee.model.js';
import { compensationTypeForJobType } from '../constants/atsPipeline.js';

const dryRun = process.argv.includes('--dry');

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const offers = await Offer.find({}).select('_id jobType compensationType').lean();
  let offerUpdates = 0;
  for (const o of offers) {
    const derived = compensationTypeForJobType(o.jobType);
    if (o.compensationType !== derived) {
      offerUpdates += 1;
      if (!dryRun) {
        await Offer.updateOne(
          { _id: o._id },
          { $set: { compensationType: derived, compensationSource: 'jobTypeDerived' } }
        );
      }
    }
  }

  const employees = await Employee.find({}).select('_id').lean();
  let employeeUpdates = 0;
  for (const e of employees) {
    const acceptedOffer = await Offer.findOne({ candidate: e._id, status: 'Accepted' })
      .sort({ acceptedAt: -1 })
      .select('compensationType jobType')
      .lean();
    const compensationType = acceptedOffer
      ? acceptedOffer.compensationType || compensationTypeForJobType(acceptedOffer.jobType)
      : 'paid';
    employeeUpdates += 1;
    if (!dryRun) {
      await Employee.updateOne(
        { _id: e._id },
        { $set: { compensationType, compensationSource: 'jobTypeDerived' } }
      );
    }
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Offers updated: ${offerUpdates}/${offers.length}; ` +
      `Employees written: ${employeeUpdates}/${employees.length}`
  );
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
