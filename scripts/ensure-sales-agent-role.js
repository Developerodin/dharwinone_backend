/* eslint-disable no-console -- CLI */
/**
 * Idempotent: ensure Role `sales_agent` exists with read-only ATS candidate access (referral leads + employees read).
 * Run from backend root: node scripts/ensure-sales-agent-role.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Role from '../src/models/role.model.js';
import { SALES_AGENT_ROLE_NAME } from '../src/utils/roleHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL is not set');
  process.exit(1);
}

const DEFAULT_PERMISSIONS = ['ats.candidates:view'];

async function main() {
  await mongoose.connect(MONGODB_URL);
  const existing = await Role.findOne({ name: SALES_AGENT_ROLE_NAME });
  if (existing) {
    console.log(`Role "${SALES_AGENT_ROLE_NAME}" already exists (id=${existing._id}). No change.`);
    await mongoose.disconnect();
    return;
  }
  await Role.create({
    name: SALES_AGENT_ROLE_NAME,
    permissions: DEFAULT_PERMISSIONS,
    status: 'active',
  });
  console.log(`Created role "${SALES_AGENT_ROLE_NAME}" with permissions:`, DEFAULT_PERMISSIONS);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
