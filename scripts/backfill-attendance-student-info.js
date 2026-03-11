/**
 * Backfill studentName and studentEmail on Attendance records that are missing them.
 * Fetches name/email from Student -> User and updates the Attendance document.
 * Run: node scripts/backfill-attendance-student-info.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;

if (!MONGODB_URL) {
  console.error('❌ MONGODB_URL not found in environment variables');
  process.exit(1);
}

async function backfill() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URL);
    console.log('✅ Connected to MongoDB');

    const Attendance = (await import('../src/models/attendance.model.js')).default;
    const Student = (await import('../src/models/student.model.js')).default;
    const User = (await import('../src/models/user.model.js')).default;

    const records = await Attendance.find({
      $or: [
        { studentName: { $in: [null, '', undefined] } },
        { studentEmail: { $in: [null, '', undefined] } },
      ],
    })
      .select('_id student studentName studentEmail')
      .lean();

    console.log(`\n📋 Found ${records.length} attendance record(s) to backfill\n`);

    if (records.length === 0) {
      console.log('✅ Nothing to backfill.');
      return;
    }

    // Phase 1: Resolve via Student → User
    const studentIds = [...new Set(records.map((r) => r.student?.toString()).filter(Boolean))];
    const students = await Student.find({ _id: { $in: studentIds } })
      .populate('user', 'name email')
      .lean();
    const studentMap = new Map(students.map((s) => [String(s._id), s]));

    // Phase 2: For orphans (deleted students), resolve User by stored email
    const orphanEmails = [...new Set(
      records
        .filter((r) => !studentMap.has(r.student?.toString()) && r.studentEmail)
        .map((r) => r.studentEmail)
    )];
    const usersByEmail = orphanEmails.length > 0
      ? await User.find({ email: { $in: orphanEmails } }).select('name email').lean()
      : [];
    const emailToUser = new Map(usersByEmail.map((u) => [u.email, u]));

    console.log(`  Phase 1: ${students.length} students found for ${studentIds.length} IDs`);
    console.log(`  Phase 2: ${usersByEmail.length} users found for ${orphanEmails.length} orphan emails\n`);

    let updated = 0;
    let skipped = 0;
    let noData = 0;

    for (const rec of records) {
      const studentId = rec.student?.toString();
      const student = studentId ? studentMap.get(studentId) : null;
      const userFromStudent = student?.user;
      const userFromEmail = !userFromStudent && rec.studentEmail ? emailToUser.get(rec.studentEmail) : null;
      const name = userFromStudent?.name ?? userFromEmail?.name ?? '';
      const email = userFromStudent?.email ?? userFromEmail?.email ?? '';

      if (!name && !email) {
        noData += 1;
        continue;
      }
      const update = {};
      if ((!rec.studentName || rec.studentName.trim() === '') && name) update.studentName = name;
      if ((!rec.studentEmail || rec.studentEmail.trim() === '') && email) update.studentEmail = email;
      if (Object.keys(update).length > 0) {
        await Attendance.updateOne({ _id: rec._id }, { $set: update });
        updated += 1;
        if (updated <= 15) {
          console.log(`  ✅ ${rec._id} → name: ${update.studentName ?? '(unchanged)'} / email: ${update.studentEmail ?? '(unchanged)'}`);
        }
      } else {
        skipped += 1;
      }
    }

    if (updated > 15) {
      console.log(`  ... and ${updated - 15} more`);
    }

    console.log(`\n📊 Summary:`);
    console.log(`  ✅ Updated: ${updated}`);
    console.log(`  ⏭️  Skipped (already has data): ${skipped}`);
    console.log(`  ⚠️  No data available: ${noData}`);
    console.log(`  📋 Total processed: ${records.length}`);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

backfill();
