import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error('Missing MONGODB_URL');
  process.exit(1);
}

const roleSchema = new mongoose.Schema({ name: String }, { strict: false });
const userSchema = new mongoose.Schema({}, { strict: false });
const employeeSchema = new mongoose.Schema({}, { strict: false });

const Role = mongoose.models.Role || mongoose.model('Role', roleSchema);
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema, 'candidates');

async function main() {
  await mongoose.connect(MONGO_URL);
  const today = new Date();

  const roles = await Role.find({}, { _id: 1, name: 1 }).lean();
  console.log('\n=== Role docs ===');
  for (const r of roles) console.log(`  ${r._id}  ${r.name}`);

  const empRoleDocs = roles.filter((r) => /^(employee|candidate)$/i.test(r.name));
  const empRoleIds = empRoleDocs.map((r) => r._id);
  console.log(`\nEmployee/Candidate Role doc count: ${empRoleDocs.length}`);
  console.log('  ids:', empRoleIds.map(String));

  const ownerUsers = await User.find(
    { roleIds: { $in: empRoleIds }, status: { $ne: 'deleted' } },
    { _id: 1, name: 1, email: 1, status: 1, roleIds: 1 }
  ).lean();
  console.log(`\nUsers with Employee/Candidate role (status != deleted): ${ownerUsers.length}`);
  const ownerIds = ownerUsers.map((u) => u._id);

  const totalEmpDocs = await Employee.countDocuments({});
  const empWithOwnerInList = await Employee.countDocuments({ owner: { $in: ownerIds } });
  const empNoOwner = await Employee.countDocuments({ $or: [{ owner: null }, { owner: { $exists: false } }] });
  console.log(`\nEmployee (candidates) collection:`);
  console.log(`  total Employee docs: ${totalEmpDocs}`);
  console.log(`  Employee.owner ∈ active-Employee-User list: ${empWithOwnerInList}`);
  console.log(`  Employee with NO owner: ${empNoOwner}`);

  const activeFilter = {
    owner: { $in: ownerIds },
    $or: [{ resignDate: null }, { resignDate: { $exists: false } }, { resignDate: { $gt: today } }],
  };
  const resignedFilter = { owner: { $in: ownerIds }, resignDate: { $ne: null, $lte: today } };
  const activeCount = await Employee.countDocuments(activeFilter);
  const resignedCount = await Employee.countDocuments(resignedFilter);
  console.log(`\nWith owner-filter:`);
  console.log(`  active:   ${activeCount}`);
  console.log(`  resigned: ${resignedCount}`);
  console.log(`  total:    ${activeCount + resignedCount}`);

  const allEmpOwnerRefs = await Employee.distinct('owner');
  const validOwnerSet = new Set(ownerIds.map(String));
  const orphans = allEmpOwnerRefs.filter((o) => o && !validOwnerSet.has(String(o)));
  console.log(`\nEmployee.owner refs total (distinct): ${allEmpOwnerRefs.length}`);
  console.log(`Employee.owner refs NOT in active-Employee-User set: ${orphans.length}`);
  if (orphans.length) {
    const orphanUsers = await User.find(
      { _id: { $in: orphans } },
      { _id: 1, name: 1, email: 1, status: 1, roleIds: 1 }
    ).lean();
    console.log(`  matching User docs found for orphan owners: ${orphanUsers.length}`);
    for (const u of orphanUsers) {
      console.log(`    ${u._id}  status=${u.status}  roleIds=${(u.roleIds || []).map(String).join(',')}  name=${u.name}`);
    }
    const missing = orphans.length - orphanUsers.length;
    if (missing > 0) console.log(`  ${missing} orphan owner Ids have NO User doc (deleted)`);
  }

  const siteOwners = await User.find(
    { roleIds: { $in: empRoleIds }, status: { $in: ['active', 'pending'] } },
    { _id: 1 }
  ).distinct('_id');
  const siteActive = await Employee.countDocuments({
    owner: { $in: siteOwners },
    $or: [{ resignDate: null }, { resignDate: { $exists: false } }, { resignDate: { $gt: today } }],
  });
  console.log(`\nSite-equivalent (User.status in ['active','pending']):`);
  console.log(`  active employees: ${siteActive}`);

  const superUsers = await User.find(
    { platformSuperUser: true },
    { _id: 1, name: 1, email: 1, roleIds: 1, status: 1 }
  ).lean();
  console.log(`\nplatformSuperUser=true count: ${superUsers.length}`);
  for (const u of superUsers) {
    console.log(`  ${u._id}  status=${u.status}  roleIds=${(u.roleIds || []).map(String).join(',')}  name=${u.name}  email=${u.email}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
