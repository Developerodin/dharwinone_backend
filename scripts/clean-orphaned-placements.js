/**
 * Remove placements with orphaned candidate or job refs (linked docs deleted).
 * Run: node scripts/clean-orphaned-placements.js
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

    const placements = await Placement.find({}).select('_id candidate job employeeId joiningDate status').lean();
    const toDelete = [];

    for (const p of placements) {
      const candidateExists = p.candidate
        ? (await Candidate.findById(p.candidate).select('_id').lean()) != null
        : false;
      const jobExists = p.job ? (await Job.findById(p.job).select('_id').lean()) != null : false;

      if (!candidateExists || !jobExists) {
        toDelete.push({
          _id: p._id,
          employeeId: p.employeeId,
          joiningDate: p.joiningDate,
          status: p.status,
          reason: !candidateExists && !jobExists ? 'candidate + job missing' : !candidateExists ? 'candidate missing' : 'job missing',
        });
      }
    }

    if (toDelete.length === 0) {
      console.log('No orphaned placements found.');
      return;
    }

    console.log(`Found ${toDelete.length} orphaned placement(s):`);
    toDelete.forEach((p) => console.log(`  - ${p._id} (employeeId: ${p.employeeId}, status: ${p.status}) - ${p.reason}`));

    const ids = toDelete.map((p) => p._id);
    const result = await Placement.deleteMany({ _id: { $in: ids } });
    console.log(`\nDeleted ${result.deletedCount} placement(s).`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

run();
