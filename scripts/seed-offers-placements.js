/**
 * Seed script: Creates JobApplications, Offers, and Placements
 * using existing Jobs and Candidates from the database.
 *
 * Run: node scripts/seed-offers-placements.js
 * Requires: .env with MONGODB_URL
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Job from '../src/models/job.model.js';
import Candidate from '../src/models/candidate.model.js';
import User from '../src/models/user.model.js';
import JobApplication from '../src/models/jobApplication.model.js';
import Offer from '../src/models/offer.model.js';
import Placement from '../src/models/placement.model.js';

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

  const jobs = await Job.find({}).limit(20).lean();
  const candidates = await Candidate.find({}).limit(30).lean();
  const users = await User.find({}).limit(5).lean();

  if (jobs.length === 0 || candidates.length === 0 || users.length === 0) {
    console.log('Need at least 1 job, 1 candidate, and 1 user. Exiting.');
    process.exit(1);
  }

  const creatorId = users[0]._id;
  const now = new Date();

  // 1. Create JobApplications (job + candidate pairs)
  const existingPairs = await JobApplication.find({}).select('job candidate').lean();
  const pairSet = new Set(existingPairs.map((p) => `${p.job}-${p.candidate}`));

  const statuses = ['Applied', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'];
  const appsCreated = [];
  let appCount = 0;

  for (let i = 0; i < Math.min(jobs.length, 12); i++) {
    for (let j = 0; j < Math.min(candidates.length, 8); j++) {
      const jobId = jobs[i]._id;
      const candId = candidates[j]._id;
      const key = `${jobId}-${candId}`;
      if (pairSet.has(key)) continue;
      pairSet.add(key);

      const status = statuses[appCount % statuses.length];
      const doc = {
        job: jobId,
        candidate: candId,
        status,
        notes: `Seed application ${appCount + 1}`,
        appliedBy: creatorId,
        createdAt: new Date(now.getTime() - (appCount + 1) * 86400000),
        updatedAt: now,
      };
      const created = await JobApplication.create(doc);
      appsCreated.push({ _id: created._id, job: jobId, candidate: candId, status });
      appCount++;
      if (appCount >= 25) break;
    }
    if (appCount >= 25) break;
  }
  console.log(`Created ${appsCreated.length} job applications`);

  // 2. Pick applications for offers: new apps + existing apps that don't have offers
  const interviewApps = appsCreated.filter((a) => a.status === 'Interview');
  const appsForOfferFromNew = interviewApps.length >= 5 ? interviewApps : appsCreated.slice(0, 8);
  const existingAppsNoOffer = await JobApplication.aggregate([
    { $lookup: { from: 'offers', localField: '_id', foreignField: 'jobApplication', as: 'offers' } },
    { $match: { offers: { $size: 0 }, status: { $in: ['Interview', 'Applied', 'Screening'] } } },
    { $limit: 10 },
    { $project: { _id: 1, job: 1, candidate: 1, status: 1 } },
  ]).exec();
  const existingForOffer = existingAppsNoOffer.map((a) => ({
    _id: a._id,
    job: a.job,
    candidate: a.candidate,
    status: a.status,
  }));
  const allAppsForOffer = [
    ...appsForOfferFromNew,
    ...existingForOffer.filter((e) => !appsForOfferFromNew.some((n) => n._id.toString() === e._id.toString())),
  ].slice(0, 15);

  const offersCreated = [];

  for (const app of allAppsForOffer) {
    const existingOffer = await Offer.findOne({ jobApplication: app._id });
    if (existingOffer) continue;

    // Prefer Accepted so Offers, Pre-boarding and Onboarding get more data
    const offerStatuses = ['Accepted', 'Accepted', 'Accepted', 'Accepted', 'Accepted', 'Sent', 'Draft', 'Under Negotiation', 'Rejected'];
    const idx = offersCreated.length % offerStatuses.length;
    const status = offerStatuses[idx];

    const joiningDate = new Date(now);
    joiningDate.setDate(joiningDate.getDate() + 14);

    const offerCode = await Offer.generateOfferCode();

    const offerDoc = {
      offerCode,
      jobApplication: app._id,
      job: app.job,
      candidate: app.candidate,
      status,
      ctcBreakdown: {
        base: 800000,
        hra: 96000,
        specialAllowances: 50000,
        otherAllowances: 24000,
        gross: 970000,
        currency: 'INR',
      },
      joiningDate,
      offerValidityDate: new Date(now.getTime() + 30 * 86400000),
      notes: 'Seed offer',
      createdBy: creatorId,
      createdAt: now,
      updatedAt: now,
    };
    if (status === 'Sent' || status === 'Under Negotiation' || status === 'Accepted') {
      offerDoc.sentAt = new Date(now.getTime() - 7 * 86400000);
    }
    if (status === 'Accepted') {
      offerDoc.acceptedAt = new Date(now.getTime() - 3 * 86400000);
    }
    if (status === 'Rejected') {
      offerDoc.rejectedAt = new Date(now.getTime() - 2 * 86400000);
      offerDoc.rejectionReason = 'Candidate declined';
    }

    const createdOffer = await Offer.create(offerDoc);
    offersCreated.push({
      _id: createdOffer._id,
      jobApplication: app._id,
      job: app.job,
      candidate: app.candidate,
      status,
      joiningDate: offerDoc.joiningDate,
      createdBy: creatorId,
    });

    await JobApplication.updateOne(
      { _id: app._id },
      { $set: { status: status === 'Accepted' ? 'Hired' : status === 'Rejected' ? 'Rejected' : 'Offered' } }
    );
  }
  console.log(`Created ${offersCreated.length} offers`);

  // 3. Create Placements for Accepted offers (from this run + any existing in DB)
  const acceptedFromRun = offersCreated.filter((o) => o.status === 'Accepted');
  let existingAccepted = await Offer.find({ status: 'Accepted' }).select('_id job candidate joiningDate createdBy').lean();
  // If no Accepted offers exist, upgrade one existing offer so we can create placements
  if (acceptedFromRun.length === 0 && existingAccepted.length === 0) {
    const anyOffer = await Offer.findOne({}).sort({ createdAt: -1 }).select('_id job candidate joiningDate createdBy').lean();
    if (anyOffer) {
      await Offer.updateOne({ _id: anyOffer._id }, { $set: { status: 'Accepted', acceptedAt: now } });
      const jobApp = await JobApplication.findOne({ job: anyOffer.job, candidate: anyOffer.candidate });
      if (jobApp) await JobApplication.updateOne({ _id: jobApp._id }, { $set: { status: 'Hired' } });
      existingAccepted = [anyOffer];
    }
  }
  const acceptedOffers = [
    ...acceptedFromRun.map((o) => ({
      _id: o._id,
      job: o.job,
      candidate: o.candidate,
      joiningDate: o.joiningDate,
      createdBy: o.createdBy,
    })),
    ...existingAccepted.filter((e) => !acceptedFromRun.some((r) => r._id.toString() === e._id.toString())),
  ];
  for (const off of acceptedOffers) {
    const existingPlacement = await Placement.findOne({ offer: off._id });
    if (existingPlacement) continue;

    const joiningDate = off.joiningDate || new Date(Date.now() + 14 * 86400000);
    const createdBy = off.createdBy || creatorId;

    const cand = await Candidate.findById(off.candidate).select('employeeId').lean();
    // Prefer Pending so placements show in Pre-boarding; some Joined for Onboarding
    const placementStatuses = ['Pending', 'Pending', 'Pending', 'Pending', 'Pending', 'Joined'];
    const idx = acceptedOffers.indexOf(off);
    const pStatus = placementStatuses[idx % placementStatuses.length];
    const isPreBoarding = pStatus === 'Pending';

    const preBoardingStatuses = ['Pending', 'In Progress', 'Completed'];
    const bgvStatuses = ['Pending', 'In Progress', 'Completed', 'Verified'];
    const pbs = pStatus === 'Joined' ? 'Completed' : preBoardingStatuses[idx % preBoardingStatuses.length];
    const bgv = pStatus === 'Joined' ? 'Verified' : bgvStatuses[idx % bgvStatuses.length];

    const assetTemplates = [
      [{ name: 'Laptop', type: 'Hardware', serialNumber: 'LP-SEED-001', allocatedAt: now, notes: '' }],
      [
        { name: 'Laptop', type: 'Hardware', serialNumber: `LP-SEED-${String(idx + 1).padStart(3, '0')}`, allocatedAt: now, notes: '' },
        { name: 'Monitor', type: 'Hardware', serialNumber: `MN-SEED-${String(idx + 1).padStart(3, '0')}`, allocatedAt: now, notes: '' },
      ],
      [
        { name: 'Laptop', type: 'Hardware', serialNumber: `LP-SEED-${String(idx + 1).padStart(3, '0')}`, allocatedAt: now, notes: '' },
        { name: 'Phone', type: 'Mobile', serialNumber: `PH-SEED-${String(idx + 1).padStart(3, '0')}`, allocatedAt: now, notes: 'Company mobile' },
      ],
    ];
    const itTemplates = [
      [
        { system: 'Email', accessLevel: 'Full', provisionedAt: now, notes: '' },
        { system: 'Slack', accessLevel: 'Member', provisionedAt: now, notes: '' },
      ],
      [
        { system: 'Email', accessLevel: 'Full', provisionedAt: now, notes: '' },
        { system: 'Slack', accessLevel: 'Member', provisionedAt: now, notes: '' },
        { system: 'Jira', accessLevel: 'User', provisionedAt: now, notes: 'Project management' },
      ],
      [
        { system: 'Email', accessLevel: 'Full', provisionedAt: now, notes: '' },
        { system: 'Google Workspace', accessLevel: 'User', provisionedAt: now, notes: '' },
        { system: 'VPN', accessLevel: 'Standard', provisionedAt: now, notes: 'Remote access' },
      ],
    ];
    const assets = assetTemplates[idx % assetTemplates.length];
    const itAccess = itTemplates[idx % itTemplates.length];

    const placementDoc = {
      offer: off._id,
      candidate: off.candidate,
      job: off.job,
      joiningDate,
      employeeId: cand?.employeeId || null,
      status: pStatus,
      preBoardingStatus: pbs,
      backgroundVerification: {
        status: bgv,
        requestedAt: new Date(now.getTime() - 10 * 86400000),
        completedAt: pStatus === 'Joined' ? new Date(now.getTime() - 2 * 86400000) : (bgv === 'Verified' ? new Date(now.getTime() - 1 * 86400000) : null),
        agency: isPreBoarding ? 'BackgroundCheck Inc' : 'Verified Agency',
        notes: 'Seed BGV',
      },
      assetAllocation: assets,
      itAccess,
      notes: 'Seed placement',
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await Placement.create(placementDoc);
  }
  console.log(`Created ${acceptedOffers.length} placements for Accepted offers`);

  console.log('Seed complete.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
