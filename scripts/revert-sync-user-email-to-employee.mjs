/**
 * Revert Employee.email values overwritten by sync-user-email-to-employee.mjs --apply
 * on 2026-05-27 (11 records from terminal audit output).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const REVERTS = [
  { employeeId: 'DBS112', email: 'harvindersingh2593@gmail.com' },
  { employeeId: 'DBS113', email: 'jjtesthhs@gmail.com' },
  { employeeId: 'DBS142', email: 'ol.69eb577d15ec7b7217334d2b.noreply@dharwin.offers.local' },
  { employeeId: 'DBS143', email: 'ol.69eb6250998579ca3e256e5c.noreply@dharwin.offers.local' },
  { employeeId: 'DBS144', email: 'ol.69eb62b7998579ca3e256ff5.noreply@dharwin.offers.local' },
  { employeeId: 'DBS150', email: 'ol.69ef4951b096b7e629c631aa.noreply@dharwin.offers.local' },
  { employeeId: 'DBS195', email: 'tmewaf224@imashr.com' },
  { employeeId: 'DBS145', email: 'ol.69eb970c3e007e0c1dd9e3ce.noreply@dharwin.offers.local' },
  { employeeId: 'DBS148', email: 'pigomew630@donumart.com' },
  { employeeId: 'DBS183', email: 'bhavitharamadugu07@gmail.com' },
  { employeeId: 'DBS122', email: 'aquasfickeru3809@gmail.com' },
];

async function main() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const { default: Employee } = await import('../src/models/employee.model.js');

  let reverted = 0;
  for (const row of REVERTS) {
    const result = await Employee.updateOne(
      { employeeId: row.employeeId },
      { $set: { email: row.email.trim().toLowerCase() } }
    );
    if (result.matchedCount) {
      reverted += 1;
      console.log(`Reverted ${row.employeeId} → ${row.email}`);
    } else {
      console.warn(`Not found: ${row.employeeId}`);
    }
  }

  console.log(`Done. Reverted ${reverted}/${REVERTS.length} record(s).`);
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
