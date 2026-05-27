import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
if (!uri) { console.error('MONGODB_URL not set'); process.exit(1); }

await mongoose.connect(uri);
const { default: Role } = await import('../src/models/role.model.js');

const roles = await Role.find({}).lean();
console.log(`Total roles: ${roles.length}`);

const offenders = [];
const fullGrantCounts = { view: 0, full: 0, partial: 0, other: 0 };

for (const role of roles) {
  for (const p of (role.permissions || [])) {
    if (typeof p !== 'string') continue;
    const colon = p.indexOf(':');
    if (colon < 0) continue;
    const actions = p.slice(colon + 1).split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    const hasCreate = actions.includes('create');
    const hasEdit   = actions.includes('edit');
    const hasDelete = actions.includes('delete');
    const writeCount = [hasCreate, hasEdit, hasDelete].filter(Boolean).length;

    if (writeCount === 0) fullGrantCounts.view++;
    else if (writeCount === 3) fullGrantCounts.full++;
    else if (writeCount === 1 || writeCount === 2) {
      fullGrantCounts.partial++;
      offenders.push({
        roleName: role.name,
        roleId: String(role._id),
        status: role.status,
        perm: p,
        actionsPresent: actions,
        missingActions: ['create','edit','delete'].filter(a => !actions.includes(a))
      });
    } else fullGrantCounts.other++;
  }
}

console.log('\nDistribution of permission strings across all roles:');
console.log(`  view-only (no write):       ${fullGrantCounts.view}`);
console.log(`  full write (c+e+d):         ${fullGrantCounts.full}`);
console.log(`  PARTIAL write (1 or 2 of 3): ${fullGrantCounts.partial}`);
console.log(`  other shape:                ${fullGrantCounts.other}`);

if (offenders.length === 0) {
  console.log('\n[OK] Zero partial-grant offenders. Phase 0.5 derivation tightening is SAFE.');
} else {
  console.log(`\n[BLOCK] ${offenders.length} partial-grant entries across ${new Set(offenders.map(o=>o.roleId)).size} role(s):`);
  for (const o of offenders) {
    console.log(`  - role "${o.roleName}" (${o.status}): "${o.perm}" missing [${o.missingActions.join(',')}]`);
  }
  console.log('\nDecision needed: widen to full grant OR keep Phase 0 derivation.');
}

await mongoose.disconnect();
process.exit(0);
