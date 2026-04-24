/**
 * One-time: renames the User Role document from "Candidate" to "Employee" (same _id, permissions preserved).
 * Safe to re-run: no-op if Candidate is already absent or Employee already exists (different doc).
 *
 * Usage (from uat.dharwin.backend):
 *   node scripts/rename-candidate-role-to-employee.mjs
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const db = mongoose.connection.db;
  const roles = db.collection('roles');

  const employee = await roles.findOne({ name: 'Employee' });
  const candidate = await roles.findOne({ name: 'Candidate' });

  if (employee && candidate) {
    console.error(
      'Both "Employee" and "Candidate" roles exist. Resolve duplicate roles in DB, then re-run.',
    );
    process.exit(1);
  }

  if (!candidate) {
    console.log('No role named "Candidate" (already "Employee" or custom). Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  const res = await roles.updateOne({ _id: candidate._id }, { $set: { name: 'Employee' } });
  if (res.modifiedCount === 1) {
    console.log('Renamed role Candidate → Employee (same _id, permissions preserved).', String(candidate._id));
  } else {
    console.log('Update had no effect.', res);
  }
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
