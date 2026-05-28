import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const url = process.argv[2] || process.env.MONGODB_URL;
if (!url) {
  console.error('Usage: node scripts/check-ats-employees-data.mjs [mongodb-url]');
  process.exit(2);
}

const isAtlas = url.includes('mongodb+srv');
const dbName = url.split('/').pop()?.split('?')[0] || 'unknown';
const hostHint = isAtlas
  ? url.replace(/:[^:@]+@/, ':***@').split('/').slice(0, 3).join('/')
  : url.replace(/:[^:@]+@/, ':***@');

await mongoose.connect(url);
const db = mongoose.connection.db;
const roles = db.collection('roles');

const total = await roles.countDocuments({});
const active = await roles.countDocuments({ status: 'active' });
const withCandidates = await roles.countDocuments({ permissions: { $regex: /^ats\.candidates:/ } });
const withEmployees = await roles.countDocuments({ permissions: { $regex: /^ats\.employees:/ } });
const joiningSub = await roles.countDocuments({ permissions: { $regex: /^ats\.candidates\.joiningDate:/ } });
const resignSub = await roles.countDocuments({ permissions: { $regex: /^ats\.candidates\.resignDate:/ } });
const deprecatedLiterals = await roles.countDocuments({
  permissions: {
    $in: [
      'candidates.joiningDate',
      'candidates.joiningDate.read',
      'candidates.joiningDate.manage',
      'candidates.resignDate',
      'candidates.resignDate.read',
      'candidates.resignDate.manage',
    ],
  },
});

const migrationLogs = await db.collection('migration_log').countDocuments({
  version: '2026-05-28-ats-employees-permission-row',
});

const activeRoles = await roles.find({ status: 'active' }).project({ name: 1, permissions: 1 }).toArray();

const rows = activeRoles
  .map((r) => {
    const p = r.permissions || [];
    return {
      name: r.name,
      id: String(r._id),
      candidates: p.filter((x) => x.startsWith('ats.candidates:')),
      employees: p.filter((x) => x.startsWith('ats.employees:')),
      joiningDate: p.filter((x) => x.includes('joiningDate')),
      resignDate: p.filter((x) => x.includes('resignDate')),
    };
  })
  .filter(
    (r) => r.candidates.length || r.employees.length || r.joiningDate.length || r.resignDate.length
  );

const wouldMigrate = activeRoles.filter((r) => {
  const p = r.permissions || [];
  const hasCand = p.some((x) => x.startsWith('ats.candidates:'));
  const hasEmp = p.some((x) => x.startsWith('ats.employees:'));
  const hasDeprecated = p.some(
    (x) =>
      x.startsWith('ats.candidates.joiningDate:')
      || x.startsWith('ats.candidates.resignDate:')
      || [
        'candidates.joiningDate.manage',
        'candidates.resignDate.manage',
        'candidates.joiningDate.read',
        'candidates.resignDate.read',
      ].includes(x)
  );
  return hasCand && (!hasEmp || hasDeprecated);
});

console.log(
  JSON.stringify(
    {
      target: isAtlas ? 'atlas' : 'local/other',
      database: dbName,
      hostHint,
      counts: {
        totalRoles: total,
        activeRoles: active,
        withAtsCandidatesPrefix: withCandidates,
        withAtsEmployeesPrefix: withEmployees,
        withJoiningDateSubRow: joiningSub,
        withResignDateSubRow: resignSub,
        withDeprecatedLiteralKeys: deprecatedLiterals,
        migrationLogEntries: migrationLogs,
        activeRolesNeedingMigration: wouldMigrate.length,
      },
      activeRolesDetail: rows,
      rolesNeedingMigration: wouldMigrate.map((r) => ({
        name: r.name,
        id: String(r._id),
        permissions: (r.permissions || []).filter(
          (x) =>
            x.startsWith('ats.candidates')
            || x.startsWith('ats.employees')
            || x.includes('joiningDate')
            || x.includes('resignDate')
        ),
      })),
      migrationAlreadyRun: migrationLogs > 0,
    },
    null,
    2
  )
);

await mongoose.disconnect();
