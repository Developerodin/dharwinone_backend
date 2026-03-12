/**
 * Check if the Onboarding row with Employee ID DBS4 exists and if linked candidate/job exist.
 * Run: node scripts/check-dbs4-placement.js
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';
import Placement from '../src/models/placement.model.js';
import Candidate from '../src/models/candidate.model.js';
import Job from '../src/models/job.model.js';

async function run() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB\n');

    // 1. Find placements with employeeId DBS4
    const byPlacementEmployeeId = await Placement.find({ employeeId: 'DBS4' })
      .populate('candidate', 'fullName email employeeId department designation')
      .populate('job', 'title organisation')
      .lean();
    console.log(`Placements with employeeId "DBS4": ${byPlacementEmployeeId.length}`);

    // 2. Find placements where candidate.employeeId is DBS4 (in case placement.employeeId is not set)
    const candidatesWithDBS4 = await Candidate.find({ employeeId: 'DBS4' }).select('_id fullName email employeeId department designation').lean();
    console.log(`Candidates with employeeId "DBS4": ${candidatesWithDBS4.length}`);

    let placements = byPlacementEmployeeId;
    if (placements.length === 0 && candidatesWithDBS4.length > 0) {
      const candidateIds = candidatesWithDBS4.map((c) => c._id);
      placements = await Placement.find({ candidate: { $in: candidateIds }, status: 'Joined' })
        .populate('candidate', 'fullName email employeeId department designation')
        .populate('job', 'title organisation')
        .lean();
      console.log(`Placements (status Joined) linked to those candidates: ${placements.length}`);
    }

    if (placements.length === 0) {
      console.log('\nNo placement found with employeeId DBS4 or linked to a candidate with employeeId DBS4.');
      return;
    }

    for (const p of placements) {
      // Get raw placement to see stored ref IDs (populate returns null if doc deleted)
      const raw = await Placement.findById(p._id).select('candidate job').lean();
      const candidateId = raw?.candidate;
      const jobId = raw?.job;

      console.log('\n--- Placement ---');
      console.log('Placement ID:', p._id);
      console.log('Status:', p.status);
      console.log('Joining Date:', p.joiningDate);
      console.log('Placement employeeId:', p.employeeId || '(not set)');
      console.log('\nStored candidate ID:', candidateId ?? 'null');
      console.log('Stored job ID:', jobId ?? 'null');
      console.log('\nCandidate (populated):', p.candidate ? p.candidate._id : 'null');
      if (p.candidate) {
        console.log('  fullName:', p.candidate.fullName ?? '(empty)');
        console.log('  email:', p.candidate.email ?? '(empty)');
        console.log('  employeeId:', p.candidate.employeeId ?? '(empty)');
        console.log('  department:', p.candidate.department ?? '(empty)');
        console.log('  designation:', p.candidate.designation ?? '(empty)');
      } else {
        console.log('  (candidate ref is null or populate returned nothing - ref may be broken)');
      }
      console.log('\nJob ref:', p.job ? p.job._id : 'null');
      if (p.job) {
        console.log('  title:', p.job.title ?? '(empty)');
      } else {
        console.log('  (job ref is null or populate returned nothing - ref may be broken)');
      }
    }

    // 3. Check if candidate and job docs exist (populate returns null if deleted)
    for (const p of placements) {
      const raw = await Placement.findById(p._id).select('candidate job').lean();
      const candidateId = raw?.candidate;
      const jobId = raw?.job;

      if (candidateId) {
        const cand = await Candidate.findById(candidateId).select('fullName email employeeId department designation').lean();
        if (!cand) {
          console.log('\n*** CANDIDATE NOT FOUND - document was deleted, ref is orphaned:', candidateId);
        } else {
          console.log('\n*** Candidate doc exists:', JSON.stringify(cand, null, 2));
        }
      } else {
        console.log('\n*** Placement has no candidate ref');
      }
      if (jobId) {
        const job = await Job.findById(jobId).select('title organisation').lean();
        if (!job) {
          console.log('\n*** JOB NOT FOUND - document was deleted, ref is orphaned:', jobId);
        } else {
          console.log('\n*** Job doc exists:', JSON.stringify(job, null, 2));
        }
      } else {
        console.log('\n*** Placement has no job ref');
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

run();
