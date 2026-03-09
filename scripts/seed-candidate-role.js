/**
 * Seed script: Creates the Candidate role if it does not exist.
 * Candidate role grants access to Courses (candidate portal).
 *
 * Run: node scripts/seed-candidate-role.js
 * Requires: .env with MONGODB_URL
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Role from '../src/models/role.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL is required. Set it in .env');
  process.exit(1);
}

const CANDIDATE_ROLE = {
  name: 'Candidate',
  permissions: ['candidate.courses:view'],
  status: 'active',
};

async function run() {
  await mongoose.connect(MONGODB_URL);
  console.log('Connected to MongoDB');

  const existing = await Role.findOne({ name: CANDIDATE_ROLE.name });
  if (existing) {
    console.log(`Candidate role already exists (id: ${existing._id}).`);
    await mongoose.disconnect();
    process.exit(0);
    return;
  }

  const role = await Role.create(CANDIDATE_ROLE);
  console.log(`Created Candidate role (id: ${role._id}) with permissions: ${CANDIDATE_ROLE.permissions.join(', ')}.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
