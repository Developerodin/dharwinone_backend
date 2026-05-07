/**
 * One-shot diagnostic. Bucket every User carrying an Agent / agent /
 * SalesAgent role by status + platformSuperUser to explain the gap between
 * the directory count and the chatbot's count.
 *
 * Usage: node scripts/diagnose-agents.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MONGO_URL = process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URL) {
  console.error('No MongoDB URL found in env. Set MONGODB_URL.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URL);
  const Role = mongoose.connection.collection('roles');
  const User = mongoose.connection.collection('users');

  const agentRoles = await Role.find({
    name: { $in: ['Agent', 'agent', 'SalesAgent', 'Sales Agent', 'sales_agent'] },
  }).toArray();
  console.log('Agent role docs:');
  for (const r of agentRoles) console.log(`  ${r._id}  name="${r.name}"  status=${r.status}`);
  if (!agentRoles.length) {
    console.log('\nNo agent Role docs found. Re-seed roles.');
    await mongoose.disconnect();
    return;
  }

  const roleIds = agentRoles.map((r) => r._id);

  const all = await User.find(
    { roleIds: { $in: roleIds } },
    { projection: { name: 1, email: 1, status: 1, platformSuperUser: 1 } }
  ).toArray();

  console.log(`\nTotal Users with any agent role: ${all.length}`);

  const buckets = {
    active_normal: [],
    active_superuser: [],
    pending: [],
    disabled: [],
    deleted: [],
  };
  for (const u of all) {
    if (u.status === 'pending')  { buckets.pending.push(u); continue; }
    if (u.status === 'disabled') { buckets.disabled.push(u); continue; }
    if (u.status === 'deleted')  { buckets.deleted.push(u); continue; }
    if (u.platformSuperUser)     { buckets.active_superuser.push(u); continue; }
    buckets.active_normal.push(u);
  }

  console.log(`Chatbot will show:    ${buckets.active_normal.length}`);
  console.log(`  active + normal   : ${buckets.active_normal.length}   (visible)`);
  console.log(`  active + superuser: ${buckets.active_superuser.length}   (excluded - platformSuperUser)`);
  console.log(`  pending           : ${buckets.pending.length}   (excluded - status != active)`);
  console.log(`  disabled          : ${buckets.disabled.length}   (excluded - status != active)`);
  console.log(`  deleted           : ${buckets.deleted.length}   (excluded - status != active)`);

  for (const [name, list] of Object.entries(buckets)) {
    if (name === 'active_normal' || list.length === 0) continue;
    console.log(`\n  Excluded (${name}):`);
    for (const u of list) console.log(`    - ${u.name} <${u.email}> id=${u._id}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
