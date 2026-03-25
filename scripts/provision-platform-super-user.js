/**
 * Upsert the platform super user (full effective permissions via role union, hidden from directory).
 *
 * Run: node scripts/provision-platform-super-user.js
 * Requires .env: MONGODB_URL
 * Optional: PLATFORM_SUPER_EMAIL (default harvinder@superadmin.in), PLATFORM_SUPER_PASSWORD (if omitted, a compliant password is generated and printed once),
 *   PLATFORM_SUPER_NAME (default: Harvinderr Singh), FORCE_PASSWORD=1 to apply env password on existing user
 */
/* eslint-disable no-console */

import crypto from 'crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import User from '../src/models/user.model.js';
import { getRoleByName } from '../src/services/role.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/** Default login email; override with PLATFORM_SUPER_EMAIL. */
const DEFAULT_PLATFORM_SUPER_EMAIL = 'harvinder@superadmin.in';

/** Meets User schema: min 8 chars, at least one letter and one number. */
function generateCompliantPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pool = letters + digits;
  let pwd = '';
  pwd += letters[crypto.randomInt(letters.length)];
  pwd += digits[crypto.randomInt(digits.length)];
  for (let i = 0; i < 14; i += 1) {
    pwd += pool[crypto.randomInt(pool.length)];
  }
  return pwd;
}

async function run() {
  const MONGODB_URL = process.env.MONGODB_URL;
  const emailRaw = process.env.PLATFORM_SUPER_EMAIL?.trim().toLowerCase();
  const email = emailRaw || DEFAULT_PLATFORM_SUPER_EMAIL;
  const passwordFromEnv = Boolean(process.env.PLATFORM_SUPER_PASSWORD?.trim());
  const password = passwordFromEnv ? process.env.PLATFORM_SUPER_PASSWORD.trim() : generateCompliantPassword();
  const passwordWasGenerated = !passwordFromEnv;
  const name = (process.env.PLATFORM_SUPER_NAME || 'Harvinderr Singh').trim();
  const forcePassword =
    process.env.FORCE_PASSWORD === '1' || String(process.env.FORCE_PASSWORD).toLowerCase() === 'true';

  if (!MONGODB_URL) {
    console.error('MONGODB_URL is required in .env');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URL);

  const adminRole = await getRoleByName('Administrator');
  if (!adminRole) {
    console.error('Administrator role not found in database');
    await mongoose.disconnect();
    process.exit(1);
  }

  let user = await User.findOne({ email });
  if (user) {
    user.name = name || user.name;
    user.roleIds = [adminRole._id];
    user.platformSuperUser = true;
    user.hideFromDirectory = true;
    user.status = 'active';
    if (passwordWasGenerated || forcePassword) {
      user.password = password;
    }
    await user.save();
    console.log('Updated existing user (flags and Administrator role).');
    if (!passwordWasGenerated && !forcePassword) {
      console.log('Password unchanged. Set FORCE_PASSWORD=1 to apply PLATFORM_SUPER_PASSWORD, or omit password env to auto-generate.');
    }
  } else {
    user = await User.create({
      name,
      email,
      password,
      roleIds: [adminRole._id],
      platformSuperUser: true,
      hideFromDirectory: true,
      status: 'active',
    });
    console.log('Created platform super user.');
  }

  await mongoose.disconnect();

  console.log('\n--- Done ---');
  console.log('User id:', user._id.toString());
  console.log('Email:', user.email);
  if (passwordWasGenerated) {
    console.log('\n=== Login (copy now; password is not saved in the repo) ===');
    console.log('Email:   ', email);
    console.log('Password:', password);
    console.log('===========================================================\n');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
