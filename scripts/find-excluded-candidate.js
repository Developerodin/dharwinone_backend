/**
 * Find which candidate is excluded from search results.
 * The list API filters out candidates with isActive: false by default.
 * Run: node scripts/find-excluded-candidate.js
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';
import Candidate from '../src/models/candidate.model.js';

async function findExcludedCandidate() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB\n');

    const totalAll = await Candidate.countDocuments({});
    const totalActive = await Candidate.countDocuments({ isActive: { $ne: false } });
    const inactiveCandidates = await Candidate.find({ isActive: false })
      .select('fullName email employeeId _id isActive resignDate')
      .lean();

    console.log('=== Candidate Counts ===');
    console.log(`Total candidates in DB: ${totalAll}`);
    console.log(`Candidates shown in search (isActive != false): ${totalActive}`);
    console.log(`Excluded (isActive: false): ${totalAll - totalActive}\n`);

    if (inactiveCandidates.length > 0) {
      console.log('=== Excluded candidate(s) ===');
      inactiveCandidates.forEach((c, i) => {
        console.log(`${i + 1}. ${c.fullName || 'N/A'}`);
        console.log(`   Email: ${c.email || 'N/A'}`);
        console.log(`   Employee ID: ${c.employeeId || 'N/A'}`);
        console.log(`   Candidate ID: ${c._id}`);
        console.log(`   Resign Date: ${c.resignDate || 'N/A'}`);
        console.log('');
      });
    } else {
      console.log('No candidates with isActive: false found.');
      console.log('If counts still differ, the exclusion may be due to owner filter or other conditions.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

findExcludedCandidate();
