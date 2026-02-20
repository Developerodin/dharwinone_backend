/**
 * Seed script: Adds more placements in Pending status for Pre-boarding
 * using existing Accepted offers that don't have placements yet.
 *
 * Run: node scripts/seed-preboarding.js  (or npm run seed:preboarding)
 * Requires: .env with MONGODB_URL
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Offer from '../src/models/offer.model.js';
import Placement from '../src/models/placement.model.js';
import Candidate from '../src/models/candidate.model.js';
import User from '../src/models/user.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL is required. Set it in .env');
  process.exit(1);
}

const PREBOARDING_STATUSES = ['Pending', 'In Progress', 'Completed'];
const BGV_STATUSES = ['Pending', 'In Progress', 'Completed', 'Verified'];
const ASSET_SETS = [
  [{ name: 'Laptop', type: 'Hardware', serialNumber: 'LP-PB-001', notes: '' }],
  [
    { name: 'Laptop', type: 'Hardware', serialNumber: 'LP-PB-002', notes: '' },
    { name: 'Monitor', type: 'Hardware', serialNumber: 'MN-PB-002', notes: '' },
  ],
  [
    { name: 'Laptop', type: 'Hardware', serialNumber: 'LP-PB-003', notes: '' },
    { name: 'Phone', type: 'Mobile', serialNumber: 'PH-PB-003', notes: 'Company mobile' },
  ],
];
const IT_SETS = [
  [
    { system: 'Email', accessLevel: 'Full', notes: '' },
    { system: 'Slack', accessLevel: 'Member', notes: '' },
  ],
  [
    { system: 'Email', accessLevel: 'Full', notes: '' },
    { system: 'Slack', accessLevel: 'Member', notes: '' },
    { system: 'Jira', accessLevel: 'User', notes: 'Project management' },
  ],
  [
    { system: 'Email', accessLevel: 'Full', notes: '' },
    { system: 'Google Workspace', accessLevel: 'User', notes: '' },
    { system: 'VPN', accessLevel: 'Standard', notes: 'Remote access' },
  ],
];

async function run() {
  await mongoose.connect(MONGODB_URL);
  console.log('Connected to MongoDB');

  const users = await User.find({}).limit(1).lean();
  const creatorId = users[0]?._id;
  if (!creatorId) {
    console.error('Need at least 1 user in DB');
    process.exit(1);
  }

  const acceptedOffers = await Offer.find({ status: 'Accepted' })
    .select('_id job candidate joiningDate createdBy')
    .lean();

  const existingPlacements = await Placement.find({ offer: { $in: acceptedOffers.map((o) => o._id) } })
    .select('_id offer')
    .lean();
  const offersWithPlacement = new Set(existingPlacements.map((p) => p.offer.toString()));

  let offersNeedingPlacement = acceptedOffers.filter((o) => !offersWithPlacement.has(o._id.toString()));

  // If all offers have placements, remove some placements (mock data) so we can recreate for Pre-boarding
  if (offersNeedingPlacement.length === 0 && existingPlacements.length > 0) {
    const toRemove = Math.min(5, existingPlacements.length);
    const placementsToDelete = existingPlacements.slice(0, toRemove);
    for (const p of placementsToDelete) {
      await Placement.deleteOne({ _id: p._id });
      offersWithPlacement.delete(p.offer.toString());
    }
    console.log(`Removed ${toRemove} placement(s) so they can be recreated for Pre-boarding.`);
    offersNeedingPlacement = acceptedOffers.filter((o) => !offersWithPlacement.has(o._id.toString()));
  }

  if (offersNeedingPlacement.length === 0) {
    console.log('No Accepted offers needing placements. Nothing to add.');
    process.exit(0);
  }

  const now = new Date();
  let created = 0;

  for (let i = 0; i < offersNeedingPlacement.length; i++) {
    const off = offersNeedingPlacement[i];
    const joiningDate = off.joiningDate || new Date(now.getTime() + 14 * 86400000);
    const cand = await Candidate.findById(off.candidate).select('employeeId').lean();

    const pbs = PREBOARDING_STATUSES[i % PREBOARDING_STATUSES.length];
    const bgv = BGV_STATUSES[i % BGV_STATUSES.length];
    const assets = ASSET_SETS[i % ASSET_SETS.length].map((a) => ({
      ...a,
      allocatedAt: now,
    }));
    const itAccess = IT_SETS[i % IT_SETS.length].map((it) => ({
      ...it,
      provisionedAt: now,
    }));

    await Placement.create({
      offer: off._id,
      candidate: off.candidate,
      job: off.job,
      joiningDate,
      employeeId: cand?.employeeId || null,
      status: 'Pending',
      preBoardingStatus: pbs,
      backgroundVerification: {
        status: bgv,
        requestedAt: new Date(now.getTime() - 10 * 86400000),
        completedAt: bgv === 'Verified' ? new Date(now.getTime() - 1 * 86400000) : null,
        agency: 'BackgroundCheck Inc',
        notes: 'Pre-boarding seed',
      },
      assetAllocation: assets,
      itAccess,
      notes: 'Pre-boarding seed',
      createdBy: off.createdBy || creatorId,
    });
    created++;
    console.log(`  Created placement ${created} for offer ${off._id}`);
  }

  console.log(`\nDone. Created ${created} placement(s) for Pre-boarding.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
