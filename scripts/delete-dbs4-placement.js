/**
 * Remove mock placement with employeeId DBS4 from DB (orphaned onboarding row).
 * Run: node scripts/delete-dbs4-placement.js
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';
import Placement from '../src/models/placement.model.js';

async function run() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB\n');

    const result = await Placement.deleteMany({ employeeId: 'DBS4' });
    console.log(`Deleted ${result.deletedCount} placement(s) with employeeId "DBS4".`);

    if (result.deletedCount === 0) {
      console.log('No matching placement found.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

run();
