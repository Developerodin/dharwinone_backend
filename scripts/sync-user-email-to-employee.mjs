/**
 * Find Employee profiles whose login email (User.email) differs from employee.email.
 * Optionally sync User.email → Employee.email (the canonical login address).
 *
 * Usage:
 *   node scripts/sync-user-email-to-employee.mjs              # audit only
 *   node scripts/sync-user-email-to-employee.mjs --apply        # fix mismatches
 *   node scripts/sync-user-email-to-employee.mjs --employee-id DBS29 --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const employeeIdArg = (() => {
  const i = process.argv.indexOf('--employee-id');
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
})();

async function main() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const { default: User } = await import('../src/models/user.model.js');
  const { default: Employee } = await import('../src/models/employee.model.js');

  const filter = { owner: { $exists: true, $ne: null } };
  if (employeeIdArg) filter.employeeId = employeeIdArg;

  const employees = await Employee.find(filter).select('employeeId fullName email owner').lean();
  const ownerIds = [...new Set(employees.map((e) => String(e.owner)).filter(Boolean))];
  const users = await User.find({ _id: { $in: ownerIds } }).select('email name').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const mismatches = [];
  for (const emp of employees) {
    const user = userById.get(String(emp.owner));
    if (!user?.email) continue;
    const userEmail = String(user.email).trim().toLowerCase();
    const empEmail = String(emp.email || '').trim().toLowerCase();
    if (userEmail && empEmail !== userEmail) {
      mismatches.push({
        employeeId: emp.employeeId,
        fullName: emp.fullName,
        employeeEmail: emp.email,
        userEmail: user.email,
        ownerId: String(emp.owner),
      });
    }
  }

  console.log(`Checked ${employees.length} employee profile(s); ${mismatches.length} mismatch(es).`);
  for (const row of mismatches) {
    console.log(
      `  ${row.employeeId || '?'} ${row.fullName || ''}: employee=${row.employeeEmail} user=${row.userEmail}`
    );
  }

  if (!APPLY) {
    if (mismatches.length) console.log('\nRe-run with --apply to sync User.email → Employee.email.');
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  for (const row of mismatches) {
    const result = await Employee.updateOne(
      { owner: row.ownerId },
      { $set: { email: String(row.userEmail).trim().toLowerCase() } }
    );
    if (result.modifiedCount) {
      fixed += 1;
      console.log(`Fixed ${row.employeeId || row.ownerId}`);
    }
  }
  console.log(`Applied ${fixed} update(s).`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
