/**
 * Audit linked User ↔ Employee identity fields.
 *
 * Usage:
 *   node scripts/audit-user-employee-field-sync.mjs
 *   node scripts/audit-user-employee-field-sync.mjs --employee-id DBS29
 *   node scripts/audit-user-employee-field-sync.mjs --apply
 *
 * --apply only fixes rows where User.email === Employee.email (skips bad owner links).
 * Also copies Employee → User avatar when User has none but Employee does (My Profile uploads).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');

const employeeIdArg = (() => {
  const i = process.argv.indexOf('--employee-id');
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
})();

const norm = (v) => (v == null ? '' : String(v).trim());
const normEmail = (v) => norm(v).toLowerCase();
const normPic = (pic) => {
  if (!pic || typeof pic !== 'object') return '';
  return norm(pic.key || pic.url);
};

const CHECKS = [
  {
    field: 'email',
    user: (u) => normEmail(u.email),
    employee: (e) => normEmail(e.email),
    note: 'Login email; admin Users PATCH syncs after fix',
  },
  {
    field: 'name/fullName',
    user: (u) => norm(u.name),
    employee: (e) => norm(e.fullName),
    note: 'Synced on User update (name → fullName)',
  },
  {
    field: 'phoneNumber',
    user: (u) => norm(u.phoneNumber),
    employee: (e) => norm(e.phoneNumber),
    note: 'Synced on User update',
  },
  {
    field: 'countryCode',
    user: (u) => norm(u.countryCode),
    employee: (e) => norm(e.countryCode),
    note: 'Synced on User update',
  },
  {
    field: 'profilePicture',
    user: (u) => normPic(u.profilePicture),
    employee: (e) => normPic(e.profilePicture),
    note: 'Synced on User update; backfill may copy Employee → User when User empty',
  },
];

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

  const employees = await Employee.find(filter)
    .select('employeeId fullName email phoneNumber countryCode profilePicture owner')
    .lean();
  const ownerIds = [...new Set(employees.map((e) => String(e.owner)).filter(Boolean))];
  const users = await User.find({ _id: { $in: ownerIds } })
    .select('name email phoneNumber countryCode profilePicture')
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  console.log(`Checked ${employees.length} linked employee profile(s).\n`);

  const summary = {};
  for (const check of CHECKS) summary[check.field] = [];

  for (const emp of employees) {
    const user = userById.get(String(emp.owner));
    if (!user) continue;

    for (const check of CHECKS) {
      const uVal = check.user(user);
      const eVal = check.employee(emp);
      if (uVal !== eVal) {
        summary[check.field].push({
          employeeId: emp.employeeId,
          fullName: emp.fullName,
          user: uVal || '(empty)',
          employee: eVal || '(empty)',
        });
      }
    }
  }

  for (const check of CHECKS) {
    const rows = summary[check.field];
    console.log(`=== ${check.field} — ${rows.length} mismatch(es) ===`);
    console.log(`    ${check.note}`);
    for (const row of rows.slice(0, 25)) {
      console.log(
        `    ${row.employeeId || '?'} ${row.fullName}: user="${row.user}" employee="${row.employee}"`
      );
    }
    if (rows.length > 25) console.log(`    ... and ${rows.length - 25} more`);
    console.log('');
  }

  if (!APPLY) {
    const anyMismatch = Object.values(summary).some((rows) => rows.length > 0);
    if (anyMismatch) {
      console.log('Re-run with --apply to sync safely linked profiles (User.email must match Employee.email).');
    }
    await mongoose.disconnect();
    return;
  }

  let fixedEmployees = 0;
  let fixedUsers = 0;
  let skipped = 0;

  for (const emp of employees) {
    const user = userById.get(String(emp.owner));
    if (!user) continue;

    const userEmail = normEmail(user.email);
    const empEmail = normEmail(emp.email);
    if (!userEmail || userEmail !== empEmail) {
      skipped += 1;
      continue;
    }

    const employeeDoc = await Employee.findById(emp._id);
    const userDoc = await User.findById(user._id);
    if (!employeeDoc || !userDoc) continue;

    let employeeDirty = false;
    let userDirty = false;

    const userName = norm(userDoc.name);
    if (userName && employeeDoc.fullName !== userName) {
      employeeDoc.fullName = userName;
      employeeDirty = true;
    }

    const userPhone = norm(userDoc.phoneNumber);
    if (userPhone && employeeDoc.phoneNumber !== userPhone) {
      employeeDoc.phoneNumber = userPhone;
      employeeDirty = true;
    }

    if (userDoc.countryCode !== undefined && norm(userDoc.countryCode) !== norm(employeeDoc.countryCode)) {
      employeeDoc.countryCode = norm(userDoc.countryCode) || undefined;
      employeeDirty = true;
    }

    const userPic = normPic(userDoc.profilePicture);
    const empPic = normPic(employeeDoc.profilePicture);
    if (userPic && userPic !== empPic) {
      employeeDoc.profilePicture = userDoc.profilePicture;
      employeeDirty = true;
    } else if (!userPic && empPic && employeeDoc.profilePicture) {
      userDoc.profilePicture = employeeDoc.profilePicture;
      userDirty = true;
    }

    if (employeeDirty) {
      await employeeDoc.save();
      fixedEmployees += 1;
      console.log(`Synced User → Employee: ${emp.employeeId || emp._id}`);
    }
    if (userDirty) {
      await userDoc.save();
      fixedUsers += 1;
      console.log(`Synced Employee → User avatar: ${emp.employeeId || emp._id}`);
    }
  }

  console.log(`\nApply complete: ${fixedEmployees} employee row(s), ${fixedUsers} user avatar(s), ${skipped} skipped (email mismatch / bad owner link).`);

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
