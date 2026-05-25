/**
 * Diagnostic: dump every Employee row matching the two Prakhar identities to
 * explain discrepancy between roster UI and the routing test (which found
 * a different companyAssignedEmail than the screenshot showed).
 *
 * Read-only. No writes.
 *
 * Usage:
 *   node scripts/check-prakhar-rows.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const main = async () => {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const { default: Employee } = await import('../src/models/employee.model.js');

  const rows = await Employee.find({
    $or: [
      { email: /prakhar/i },
      { fullName: /prakhar/i },
      { companyAssignedEmail: /prakhar/i },
    ],
  })
    .select('_id fullName email companyAssignedEmail companyEmailProvider owner adminId employeeId createdAt updatedAt')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`\nFound ${rows.length} Employee rows matching /prakhar/:\n`);
  for (const r of rows) {
    console.log(`---`);
    console.log(`  _id:                  ${r._id}`);
    console.log(`  fullName:             ${r.fullName}`);
    console.log(`  email:                ${r.email}`);
    console.log(`  companyAssignedEmail: ${r.companyAssignedEmail || '(empty)'}`);
    console.log(`  companyEmailProvider: ${r.companyEmailProvider || '(empty)'}`);
    console.log(`  employeeId:           ${r.employeeId || '(none)'}`);
    console.log(`  owner (User):         ${r.owner}`);
    console.log(`  adminId (User):       ${r.adminId}`);
    console.log(`  createdAt:            ${r.createdAt?.toISOString?.() || r.createdAt}`);
    console.log(`  updatedAt:            ${r.updatedAt?.toISOString?.() || r.updatedAt}`);
  }

  await mongoose.disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
