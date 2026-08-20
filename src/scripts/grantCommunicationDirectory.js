#!/usr/bin/env node
/**
 * Grant contact-discovery permissions to the roles named in the source requirement.
 *
 * Usage:
 *   node src/scripts/grantCommunicationDirectory.js           # dry-run, prints the plan
 *   node src/scripts/grantCommunicationDirectory.js --apply   # writes
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import Role, { slugifyRole } from '../models/role.model.js';
import {
  DIRECTORY_ALL_PERMISSION,
  DIRECTORY_REFERRED_PERMISSION,
} from '../constants/communicationAccess.js';

const TARGETS = [
  { slug: 'administrator', permission: DIRECTORY_ALL_PERMISSION },
  { slug: 'agent', permission: DIRECTORY_ALL_PERMISSION },
  { slug: 'manager', permission: DIRECTORY_ALL_PERMISSION },
  { slug: 'mentor', permission: DIRECTORY_ALL_PERMISSION },
  { slug: 'tester', permission: DIRECTORY_ALL_PERMISSION },
  { slug: 'salesagent', permission: DIRECTORY_REFERRED_PERMISSION },
];

export const planGrants = async () => {
  const roles = await Role.find({ status: 'active' }).lean();
  const bySlug = new Map(roles.map((r) => [r.slug || slugifyRole(r.name), r]));

  const grants = [];
  const unresolved = [];

  for (const target of TARGETS) {
    const role = bySlug.get(target.slug);
    if (!role) {
      unresolved.push(target.slug);
      continue;
    }
    grants.push({
      slug: target.slug,
      roleId: String(role._id),
      roleName: role.name,
      permission: target.permission,
      alreadyHeld: (role.permissions || []).includes(target.permission),
    });
  }

  return { grants, unresolved, safeToApply: unresolved.length === 0 };
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(config.mongoose.url, config.mongoose.options);

  const plan = await planGrants();

  console.log('\n=== Contact discovery permission grants ===\n');
  for (const g of plan.grants) {
    console.log(
      `  ${g.alreadyHeld ? 'SKIP ' : 'GRANT'}  ${g.roleName.padEnd(20)} ` +
        `slug=${g.slug.padEnd(16)} _id=${g.roleId}  ->  ${g.permission}`
    );
  }

  if (!plan.safeToApply) {
    console.error(`\nUNRESOLVED SLUGS: ${plan.unresolved.join(', ')}`);
    console.error(
      'ABORTING. Discovery is deny-by-default, so an unresolved role means those users lose the\n' +
        'directory at flag-flip. Create the role, or remove it from TARGETS with a written reason.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const Users = mongoose.connection.collection('users');
  console.log('');
  for (const g of plan.grants) {
    const affected = await Users.countDocuments({ roleIds: new mongoose.Types.ObjectId(g.roleId) });
    console.log(`  ${g.roleName}: ${affected} user(s) affected`);
  }

  if (!apply) {
    console.log('\nDRY RUN. Re-run with --apply to write.\n');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const g of plan.grants) {
    if (g.alreadyHeld) continue;
    await Role.updateOne({ _id: g.roleId }, { $addToSet: { permissions: g.permission } });
    written += 1;
  }
  console.log(`\nAPPLIED. ${written} role(s) updated.\n`);
  await mongoose.disconnect();
};

if (process.argv[1] && process.argv[1].endsWith('grantCommunicationDirectory.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
