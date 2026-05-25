/**
 * Delete synthetic offer-letter shell Employee documents.
 *
 * Shells are Employee rows created by offer.service.js to anchor an Offer
 * before a real candidate account exists. They have email matching
 *   /\.noreply@dharwin\.offers\.local$/i
 * (see offer.service.js:333). They surface in the Roster page and clutter
 * counts.
 *
 * Default: DRY RUN — lists shells + their FK references; deletes nothing.
 * Pass --apply to actually delete the Employee shell docs. Referencing
 * Offer / JobApplication / Placement rows are LEFT IN PLACE so audit history
 * is preserved; only the Employee shell is removed.
 *
 * Usage:
 *   node scripts/delete-offer-shells.js
 *   node scripts/delete-offer-shells.js --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const SHELL_REGEX = /\.noreply@dharwin\.offers\.local$/i;

const main = async () => {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const { default: Employee } = await import('../src/models/employee.model.js');
  const { default: Offer } = await import('../src/models/offer.model.js');
  const { default: JobApplication } = await import('../src/models/jobApplication.model.js');
  const { default: Placement } = await import('../src/models/placement.model.js');

  const shells = await Employee.find({ email: SHELL_REGEX })
    .select('_id fullName email employeeId owner adminId createdAt')
    .lean();

  console.log(`\nMode: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no writes)'}`);
  console.log(`Found ${shells.length} shell Employee row(s) matching ${SHELL_REGEX}\n`);

  if (shells.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const ids = shells.map((s) => s._id);

  const [offerRefs, jaRefs, placementRefs] = await Promise.all([
    Offer.find({ candidate: { $in: ids } }).select('_id candidate status').lean(),
    JobApplication.find({ candidate: { $in: ids } }).select('_id candidate status').lean(),
    Placement.find({ candidate: { $in: ids } }).select('_id candidate status').lean(),
  ]);

  const byShell = new Map(shells.map((s) => [String(s._id), { offers: [], applications: [], placements: [] }]));
  offerRefs.forEach((o) => byShell.get(String(o.candidate))?.offers.push(o));
  jaRefs.forEach((j) => byShell.get(String(j.candidate))?.applications.push(j));
  placementRefs.forEach((p) => byShell.get(String(p.candidate))?.placements.push(p));

  for (const s of shells) {
    const refs = byShell.get(String(s._id));
    console.log(`---`);
    console.log(`  Employee _id:   ${s._id}`);
    console.log(`  employeeId:     ${s.employeeId || '(none)'}`);
    console.log(`  fullName:       ${s.fullName}`);
    console.log(`  email:          ${s.email}`);
    console.log(`  createdAt:      ${s.createdAt?.toISOString?.() || s.createdAt}`);
    console.log(`  Offers:         ${refs.offers.length} ${refs.offers.map((o) => `[${o.status}]`).join(' ')}`);
    console.log(`  Applications:   ${refs.applications.length} ${refs.applications.map((j) => `[${j.status}]`).join(' ')}`);
    console.log(`  Placements:     ${refs.placements.length} ${refs.placements.map((p) => `[${p.status}]`).join(' ')}`);
  }

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to delete the ${shells.length} Employee shell row(s).`);
    console.log(`(Referencing Offer/JobApplication/Placement rows will NOT be touched.)`);
    await mongoose.disconnect();
    return;
  }

  const result = await Employee.deleteMany({ _id: { $in: ids } });
  console.log(`\nDeleted ${result.deletedCount} Employee shell row(s).`);

  await mongoose.disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
