// src/scripts/backfillIdentityFromUser.js
/**
 * One-time identity convergence: per field, non-empty User value wins into the
 * Employee mirror; empty User fields adopt the Employee's value. Idempotent —
 * safe to re-run. Uses direct updateOne on both sides (no hooks, no side effects).
 *
 *   npm run backfill:identity -- --dry-run   # report only
 *   npm run backfill:identity                # apply
 *
 * Uniqueness note: userSet only adopts a value when the User field is EMPTY.
 * User.email is required, so email never flows upward — no isEmailTaken risk.
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import { computeIdentityConvergence, SYNTHETIC_EMAIL_RE } from '../utils/identityFields.js';

const dryRun = process.argv.includes('--dry-run');

const main = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const fieldCounts = {};
  let pairs = 0;
  let usersTouched = 0;
  let employeesTouched = 0;

  // An owner holding several real profiles has no decidable mirror target: converging them
  // would stamp one User's name+email onto every profile and break the candidates.email
  // unique index. Only the profile matching the User's own email is converged; the rest skip.
  const ambiguousOwners = new Set(
    (
      await Employee.aggregate([
        { $match: { owner: { $ne: null }, email: { $not: SYNTHETIC_EMAIL_RE } } },
        { $group: { _id: '$owner', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
    ).map((g) => String(g._id))
  );
  let skippedSynthetic = 0;
  let skippedAmbiguous = 0;

  const cursor = Employee.find({ owner: { $ne: null } })
    .select('owner fullName email phoneNumber countryCode profilePicture')
    .lean()
    .cursor();

  for await (const emp of cursor) {
    if (SYNTHETIC_EMAIL_RE.test(emp.email || '')) {
      skippedSynthetic += 1;
      continue;
    }
    const user = await User.findById(emp.owner)
      .select('name email phoneNumber countryCode profilePicture')
      .lean();
    if (!user) continue;
    if (
      ambiguousOwners.has(String(emp.owner)) &&
      String(emp.email || '').toLowerCase() !== String(user.email || '').toLowerCase()
    ) {
      skippedAmbiguous += 1;
      continue;
    }
    pairs += 1;

    const { userSet, employeeSet } = computeIdentityConvergence(user, emp);
    // Defensive: email is the login credential and name is required on User —
    // never adopt them upward even if a User doc is somehow missing them
    // (updateOne bypasses isEmailTaken and schema validation).
    delete userSet.email;
    delete userSet.name;
    for (const k of Object.keys(userSet)) fieldCounts[`user.${k}`] = (fieldCounts[`user.${k}`] || 0) + 1;
    for (const k of Object.keys(employeeSet)) fieldCounts[`employee.${k}`] = (fieldCounts[`employee.${k}`] || 0) + 1;

    if (!dryRun) {
      if (Object.keys(userSet).length) {
        await User.updateOne({ _id: user._id }, { $set: userSet });
        usersTouched += 1;
        console.log(`user ${user._id}: set ${Object.keys(userSet).join(',')}`);
      }
      if (Object.keys(employeeSet).length) {
        await Employee.updateOne({ _id: emp._id }, { $set: employeeSet });
        employeesTouched += 1;
        console.log(`employee ${emp._id}: set ${Object.keys(employeeSet).join(',')}`);
      }
    }
  }

  console.log(`\n${dryRun ? 'DRY RUN — ' : ''}pairs inspected: ${pairs}`);
  console.log(`skipped: synthetic=${skippedSynthetic} ambiguousOwner=${skippedAmbiguous}`);
  console.log('field diff counts:', JSON.stringify(fieldCounts, null, 2));
  if (!dryRun) console.log(`users updated: ${usersTouched}, employees updated: ${employeesTouched}`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
