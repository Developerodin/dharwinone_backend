/**
 * One-off: align User and linked Candidate phone/country when they differ.
 * Policy: use User digits if non-empty, else Candidate; same for countryCode.
 * Run: node scripts/backfill-user-candidate-phone.js
 * Dry run: DRY_RUN=1 node scripts/backfill-user-candidate-phone.js
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import User from '../src/models/user.model.js';
import Candidate from '../src/models/candidate.model.js';
import config from '../src/config/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const norm = (s) => (s == null || s === '' ? '' : String(s).trim());

async function main() {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  console.log(`Connected. DRY_RUN=${DRY}\n`);

  const candidates = await Candidate.find({ owner: { $exists: true, $ne: null } }).lean();
  let fixed = 0;

  for (const c of candidates) {
    const user = await User.findById(c.owner);
    if (!user) continue;

    const uPhone = norm(user.phoneNumber);
    const cPhone = norm(c.phoneNumber);
    const uCc = norm(user.countryCode);
    const cCc = norm(c.countryCode);

    if (uPhone === cPhone && uCc === cCc) continue;

    const canonPhone = uPhone || cPhone;
    const canonCc = uCc || cCc || undefined;

    console.log(
      `Pair owner=${c.owner} candidate=${c._id} user="${uPhone}"/"${uCc}" cand="${cPhone}"/"${cCc}" -> "${canonPhone}"/"${canonCc || ''}"`
    );

    if (!DRY) {
      if (canonPhone) {
        await User.updateOne(
          { _id: user._id },
          { $set: { phoneNumber: canonPhone, countryCode: canonCc } }
        );
        await Candidate.updateOne(
          { _id: c._id },
          { $set: { phoneNumber: canonPhone, countryCode: canonCc } }
        );
      } else if (uCc !== cCc) {
        await User.updateOne({ _id: user._id }, { $set: { countryCode: canonCc } });
        await Candidate.updateOne({ _id: c._id }, { $set: { countryCode: canonCc } });
      }
    }
    fixed += 1;
  }

  console.log(`\nDone. ${DRY ? 'Would fix' : 'Fixed'} ${fixed} pair(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
