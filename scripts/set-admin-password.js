/**
 * Set a known password for the admin user so you can log in after seeding.
 * Usage: node scripts/set-admin-password.js [email] [newPassword]
 * Default: admin@gmail.com / Admin@123
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const email = process.argv[2] || 'admin@gmail.com';
  const newPassword = process.argv[3] || 'Admin@123';

  let mongoUrl = process.env.MONGODB_URL;
  if (!mongoUrl) {
    console.error('MONGODB_URL is not set in .env');
    process.exit(1);
  }
  const match = mongoUrl.match(/^(mongodb(\+srv)?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/);
  if (match) {
    mongoUrl = `${match[1]}/uat-dharwin${match[4] || ''}`;
  }

  await mongoose.connect(mongoUrl, {});
  const User = mongoose.connection.db.collection('users');
  const user = await User.findOne({ email });
  if (!user) {
    console.error(`User not found: ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const hashed = await bcrypt.hash(newPassword, 8);
  await User.updateOne({ email }, { $set: { password: hashed } });
  console.log(`Password updated for ${email}. You can now log in with: ${newPassword}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
