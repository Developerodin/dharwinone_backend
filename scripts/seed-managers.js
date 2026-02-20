/**
 * Seed script: Creates mock manager users for Reporting Manager dropdown in Edit HRMS.
 * These users can be assigned as reporting managers to candidates during onboarding.
 *
 * Run: node scripts/seed-managers.js  (or npm run seed:managers)
 * Requires: .env with MONGODB_URL
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../src/models/user.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL is required. Set it in .env');
  process.exit(1);
}

const MOCK_MANAGERS = [
  { name: 'Rajesh Kumar', email: 'rajesh.kumar.manager@company.com' },
  { name: 'Priya Sharma', email: 'priya.sharma.manager@company.com' },
  { name: 'Amit Verma', email: 'amit.verma.manager@company.com' },
  { name: 'Sneha Patel', email: 'sneha.patel.manager@company.com' },
  { name: 'Vikram Singh', email: 'vikram.singh.manager@company.com' },
];

const DEFAULT_PASSWORD = 'Manager123';

async function run() {
  await mongoose.connect(MONGODB_URL);
  console.log('Connected to MongoDB');

  let created = 0;
  for (const m of MOCK_MANAGERS) {
    const existing = await User.findOne({ email: m.email }).lean();
    if (existing) {
      console.log(`  Skipped ${m.name} (already exists)`);
      continue;
    }
    await User.create({
      name: m.name,
      email: m.email,
      password: DEFAULT_PASSWORD,
      role: 'recruiter',
      status: 'active',
      isEmailVerified: true,
    });
    console.log(`  Created: ${m.name}`);
    created++;
  }

  console.log(`\nDone. Created ${created} manager(s).`);
  if (created > 0) {
    console.log('These users can now be selected as Reporting Manager in Edit HRMS (Onboarding).');
  }
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
