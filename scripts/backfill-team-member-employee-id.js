// uat.dharwin.backend/scripts/backfill-team-member-employee-id.js
/* eslint-disable no-console */
import 'dotenv/config';
import mongoose from 'mongoose';
import TeamMember from '../src/models/team.model.js';
import Employee from '../src/models/employee.model.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const rows = await TeamMember.find({ employeeId: { $exists: false } })
    .select('_id name email teamId').lean();

  const reportByReason = { matched: [], notFound: [], ambiguous: [] };
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email) { reportByReason.notFound.push({ id: r._id, reason: 'no_email' }); continue; }
    const matches = await Employee.find({ email }).select('_id name').lean();
    if (matches.length === 1) reportByReason.matched.push({ id: r._id, employeeId: matches[0]._id });
    else if (matches.length === 0) reportByReason.notFound.push({ id: r._id, email });
    else reportByReason.ambiguous.push({ id: r._id, email, count: matches.length });
  }

  console.log('matched:', reportByReason.matched.length);
  console.log('notFound:', reportByReason.notFound.length);
  console.log('ambiguous:', reportByReason.ambiguous.length);
  console.log(JSON.stringify(reportByReason, null, 2));

  if (APPLY) {
    for (const m of reportByReason.matched) {
      await TeamMember.updateOne({ _id: m.id }, { $set: { employeeId: m.employeeId } });
    }
    console.log(`Applied ${reportByReason.matched.length} updates.`);
  } else {
    console.log('Dry-run. Re-run with --apply to write changes.');
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
