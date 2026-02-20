/**
 * Cleanup script: Removes all Offers and Placements (seeded mock data).
 * Also resets JobApplication status for affected records (Hired->Interview, Offered->Interview).
 *
 * Run: node scripts/cleanup-offers-placements.js  (or npm run cleanup:offers-placements)
 * Requires: .env with MONGODB_URL
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Offer from '../src/models/offer.model.js';
import Placement from '../src/models/placement.model.js';
import JobApplication from '../src/models/jobApplication.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL is required. Set it in .env');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGODB_URL);
  console.log('Connected to MongoDB');

  // 1. Collect job application IDs that have offers (before deleting offers)
  const offers = await Offer.find({}).select('jobApplication').lean();
  const jobAppIds = [...new Set(offers.map((o) => o.jobApplication?.toString()).filter(Boolean))];

  // 2. Delete all Placements (they reference offers)
  const placementResult = await Placement.deleteMany({});
  console.log(`Deleted ${placementResult.deletedCount} placement(s)`);

  // 3. Delete all Offers
  const offerResult = await Offer.deleteMany({});
  console.log(`Deleted ${offerResult.deletedCount} offer(s)`);

  // 4. Reset JobApplication status (Hired -> Interview, Offered -> Interview)
  if (jobAppIds.length > 0) {
    const resetResult = await JobApplication.updateMany(
      { _id: { $in: jobAppIds }, status: { $in: ['Hired', 'Offered'] } },
      { $set: { status: 'Interview' } }
    );
    console.log(`Reset ${resetResult.modifiedCount} job application(s) status to Interview`);
  }

  console.log('Cleanup complete.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
