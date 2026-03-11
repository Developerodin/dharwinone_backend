/**
 * Fix migrated attendance records that have `candidate`/`candidateEmail` from the source DB
 * but are missing `student`/`studentEmail`/`studentName` in the current DB.
 *
 * Strategy:
 *   1. Find all attendance records missing the `student` field.
 *   2. Use `candidateEmail` to find the matching User by email in the current DB.
 *   3. Use the User to find the matching Student record.
 *   4. Set `student`, `studentEmail`, and `studentName` on the attendance record.
 *
 * READ-ONLY on source DB. Only updates the current DB.
 * Run: node scripts/fix-migrated-attendance.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error('MONGODB_URL not found');
  process.exit(1);
}

async function fix() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URL);
    console.log('Connected\n');

    const Attendance = (await import('../src/models/attendance.model.js')).default;
    const Student = (await import('../src/models/student.model.js')).default;
    const User = (await import('../src/models/user.model.js')).default;

    // Step 1: Find orphaned records (have candidateEmail but no student)
    const db = mongoose.connection.db;
    const attendanceColl = db.collection('attendances');

    const orphanedCount = await attendanceColl.countDocuments({
      $and: [
        { candidateEmail: { $exists: true, $ne: null, $ne: '' } },
        { $or: [{ student: null }, { student: { $exists: false } }] },
      ],
    });
    console.log(`Found ${orphanedCount} orphaned attendance records with candidateEmail\n`);

    if (orphanedCount === 0) {
      console.log('Nothing to fix.');
      return;
    }

    // Step 2: Get distinct candidateEmails from orphaned records
    const distinctEmails = await attendanceColl.distinct('candidateEmail', {
      $or: [{ student: null }, { student: { $exists: false } }],
    });
    console.log(`Distinct candidateEmails: ${distinctEmails.length}\n`);

    // Step 3: For each email, find User -> Student in current DB
    const allUsers = await User.find({ email: { $in: distinctEmails } }).select('_id name email').lean();
    const emailToUser = new Map(allUsers.map((u) => [u.email, u]));
    console.log(`Found ${allUsers.length} matching users in current DB\n`);

    const Candidate = (await import('../src/models/candidate.model.js')).default;

    const allStudents = await Student.find({
      user: { $in: allUsers.map((u) => u._id) },
    }).select('_id user').lean();
    const userIdToStudent = new Map(allStudents.map((s) => [s.user.toString(), s]));
    console.log(`Found ${allStudents.length} matching students in current DB\n`);

    // Step 4: Build email -> { student, studentName, studentEmail } map
    // Auto-create Student records for users who don't have one yet
    const emailToData = new Map();
    let noUser = 0;
    let noStudent = 0;
    let createdStudents = 0;
    for (const email of distinctEmails.filter(Boolean)) {
      const user = emailToUser.get(email);
      if (!user) {
        noUser++;
        continue;
      }
      let student = userIdToStudent.get(user._id.toString());
      if (!student) {
        noStudent++;
        // Auto-create Student for this user
        try {
          const candidate = await Candidate.findOne({ owner: user._id }).select('joiningDate').lean()
            || await Candidate.findOne({ email: user.email }).select('joiningDate').lean();
          const joiningDate = candidate?.joiningDate || null;
          const newStudent = await Student.create({ user: user._id, status: 'active', joiningDate });
          student = { _id: newStudent._id, user: user._id };
          userIdToStudent.set(user._id.toString(), student);
          createdStudents++;
          console.log(`  Created Student for ${email} (joiningDate: ${joiningDate || 'none'})`);
        } catch (createErr) {
          console.warn(`  Failed to create Student for ${email}: ${createErr.message}`);
          emailToData.set(email, { student: null, studentName: user.name, studentEmail: user.email });
          continue;
        }
      }
      emailToData.set(email, {
        student: student._id,
        studentName: user.name,
        studentEmail: user.email,
      });
    }
    console.log(`  Auto-created ${createdStudents} new Student records\n`);

    const withStudent = [...emailToData.values()].filter((d) => d.student).length;
    const withoutStudent = [...emailToData.values()].filter((d) => !d.student).length;
    console.log(`Mappings: ${withStudent} with Student, ${withoutStudent} with User only, ${noUser} no User found\n`);

    // Step 5: Update records in bulk per email
    let totalUpdated = 0;
    let totalStudentLinked = 0;
    let totalNameOnly = 0;
    let totalSkipped = 0;

    for (const email of distinctEmails.filter(Boolean)) {
      const data = emailToData.get(email);
      if (!data) {
        const count = await attendanceColl.countDocuments({
          candidateEmail: email,
          $or: [{ student: null }, { student: { $exists: false } }],
        });
        totalSkipped += count;
        continue;
      }

      const update = {
        studentEmail: data.studentEmail,
        studentName: data.studentName || '',
      };
      if (data.student) {
        update.student = data.student;
      }

      const result = await attendanceColl.updateMany(
        {
          candidateEmail: email,
          $or: [{ student: null }, { student: { $exists: false } }],
        },
        { $set: update }
      );

      if (result.modifiedCount > 0) {
        totalUpdated += result.modifiedCount;
        if (data.student) {
          totalStudentLinked += result.modifiedCount;
        } else {
          totalNameOnly += result.modifiedCount;
        }
        if (totalStudentLinked + totalNameOnly <= 20) {
          console.log(`  ${email} → ${data.studentName} (${result.modifiedCount} records, ${data.student ? 'linked to student' : 'name/email only'})`);
        }
      }
    }

    if (totalUpdated > 20) {
      console.log(`  ... and more`);
    }

    console.log(`\n=== Summary ===`);
    console.log(`  Total records updated: ${totalUpdated}`);
    console.log(`    Linked to Student: ${totalStudentLinked}`);
    console.log(`    Name/email only (no Student): ${totalNameOnly}`);
    console.log(`  Skipped (no User found): ${totalSkipped}`);
    console.log(`  Emails with no User in current DB: ${noUser}`);
    console.log(`  Emails with User but no Student: ${noStudent}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nDisconnected');
    process.exit(0);
  }
}

fix();
