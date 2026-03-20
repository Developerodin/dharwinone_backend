/**
 * Seed script: Creates or updates the Agent role with attendance permissions.
 * Agent role grants training.attendance:view,create,edit for punch-in/out and attendance assignment.
 * Idempotent: safe to run multiple times.
 *
 * Run: node scripts/seed-agent-role.js
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

const AGENT_ROLE_NAME = 'Agent';
/** Attendance + edit candidate joining / resign dates (syncs with Student for punch eligibility). */
const AGENT_PERMISSIONS = [
  'training.attendance:view,create,edit',
  'ats.candidates.joiningDate:view,edit',
  'ats.candidates.resignDate:view,edit',
];

async function run() {
  await mongoose.connect(MONGODB_URL);
  console.log('Connected to MongoDB');

  const existing = await Role.findOne({ name: AGENT_ROLE_NAME });
  if (existing) {
    const hasExpected = AGENT_PERMISSIONS.every((p) => existing.permissions && existing.permissions.includes(p));
    if (hasExpected && existing.permissions.length === AGENT_PERMISSIONS.length) {
      console.log(`Agent role already has correct permissions (id: ${existing._id}).`);
      await mongoose.disconnect();
      process.exit(0);
      return;
    }
    await Role.findByIdAndUpdate(existing._id, { permissions: AGENT_PERMISSIONS, status: 'active' });
    console.log(`Updated Agent role (id: ${existing._id}) with permissions: ${AGENT_PERMISSIONS.join(', ')}.`);
  } else {
    const role = await Role.create({
      name: AGENT_ROLE_NAME,
      permissions: AGENT_PERMISSIONS,
      status: 'active',
    });
    console.log(`Created Agent role (id: ${role._id}) with permissions: ${AGENT_PERMISSIONS.join(', ')}.`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
