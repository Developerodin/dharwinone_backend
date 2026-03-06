/**
 * Check if a user exists in the database and show account details.
 * Run: node scripts/check-user.js prakhar@theodin.in
 *
 * Note: Passwords are bcrypt-hashed and cannot be retrieved.
 * Use forgot-password flow or an admin reset to set a new password.
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const email = process.argv[2] || 'prakhar@theodin.in';

async function checkUser() {
  await mongoose.connect(process.env.MONGODB_URL);
  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  const user = await User.findOne({ email: email.toLowerCase().trim() }).lean();
  if (!user) {
    console.log(`\nNo user found with email: ${email}\n`);
    process.exit(1);
  }
  console.log('\n--- User account found ---\n');
  console.log('Name:', user.name);
  console.log('Email:', user.email);
  console.log('Username:', user.username || '(not set)');
  console.log('Status:', user.status);
  console.log('Role:', user.role);
  console.log('Created:', user.createdAt);
  console.log('\n--- Login ---\n');
  console.log('Email (login):', user.email);
  console.log('Password: [stored as bcrypt hash - cannot be retrieved]\n');
  console.log('If you forgot the password, use "Forgot password" on the login page,');
  console.log('or an admin can reset it from the Users management screen.\n');
  await mongoose.disconnect();
  process.exit(0);
}

checkUser().catch((err) => {
  console.error(err);
  process.exit(1);
});
