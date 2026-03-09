/**
 * Reset password for a user by ID.
 * Run: node scripts/reset-user-password.js <userId>
 *
 * Requires: .env with MONGODB_URL
 * Output: New password is printed to the console. Copy it and share securely.
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import User from '../src/models/user.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const userId = process.argv[2] || '698055509006e262e362d387';

// Generate a secure password: 12 chars, letters + numbers (meets user schema validation)
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  let pwd = '';
  pwd += letters[Math.floor(Math.random() * letters.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  for (let i = 0; i < 10; i++) {
    const pool = letters + digits;
    pwd += pool[Math.floor(Math.random() * pool.length)];
  }
  return crypto.randomBytes(2).toString('hex').slice(0, 2) + pwd; // shuffle start
}

async function resetPassword() {
  const MONGODB_URL = process.env.MONGODB_URL;
  if (!MONGODB_URL) {
    console.error('MONGODB_URL is required. Set it in .env');
    process.exit(1);
  }

  const newPassword = generatePassword();

  await mongoose.connect(MONGODB_URL);
  const user = await User.findById(userId);
  if (!user) {
    console.error(`User not found: ${userId}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  user.password = newPassword;
  await user.save();
  await mongoose.disconnect();

  console.log('\n--- Password reset successful ---\n');
  console.log('User ID:', userId);
  console.log('Email:', user.email);
  console.log('Name:', user.name);
  console.log('\nNew password:', newPassword);
  console.log('\nShare this password securely. User can change it after login.\n');
}

resetPassword().catch((err) => {
  console.error(err);
  process.exit(1);
});
