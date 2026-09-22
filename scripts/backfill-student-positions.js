/**
 * One-off backfill: set Student.position from the linked Employee's designation
 * when position is unset.
 *
 * Students created without a position are invisible to every module employee
 * dropdown (resolveStudentIdsForPositions), which is why the roster and the
 * dropdown disagreed.
 *
 * Resolution matches the *lookup* half of employee.service.js's
 * resolvePositionIdFromDesignation (same case-insensitive name regex). It does
 * NOT create Positions — creating would make every designation "resolvable"
 * and erase the unresolvable list the plan asks a human to review.
 *
 * Employee documents live in the `candidates` collection (Employee model).
 *
 * Usage:
 *   node scripts/backfill-student-positions.js            # dry-run (default)
 *   node scripts/backfill-student-positions.js --dry-run
 *   node scripts/backfill-student-positions.js --apply
 *   node scripts/backfill-student-positions.js --undo <journal.json>
 *
 * ⚠️ Default MONGODB_URL is the SHARED staging + local database.
 * ⚠️ PRODUCTION DB — run against prod separately after staging is verified.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPLY = process.argv.includes('--apply');
const undoIdx = process.argv.indexOf('--undo');
const UNDO_PATH = undoIdx >= 0 ? process.argv[undoIdx + 1] : null;

const escapeRegex = (v) => String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find an existing Position by title (read-only; never creates).
 * @param {string} title
 * @returns {Promise<import('mongoose').Types.ObjectId|null>}
 */
async function findPositionIdByTitle(title) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return null;
  const nameRegex = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  const existing = await mongoose.connection.db
    .collection('positions')
    .findOne({ name: { $regex: nameRegex } }, { projection: { _id: 1 } });
  return existing?._id ?? null;
}

/** Same title fallbacks as position.service getJobTitleCandidates. */
function getJobTitleCandidates(employee) {
  const titles = [];
  for (const value of [employee?.designation, employee?.referralJobTitle]) {
    const trimmed = String(value ?? '').trim();
    if (trimmed) titles.push(trimmed);
  }
  return titles;
}

async function runUndo(journalPath) {
  const abs = path.resolve(journalPath);
  const journal = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(journal)) {
    throw new Error('Journal must be a JSON array');
  }
  const students = mongoose.connection.db.collection('students');
  let reverted = 0;
  for (const entry of journal) {
    const res = await students.updateOne(
      { _id: new mongoose.Types.ObjectId(entry.studentId) },
      {
        $set: {
          position:
            entry.from === null || entry.from === undefined
              ? null
              : new mongoose.Types.ObjectId(entry.from),
        },
      }
    );
    reverted += res.modifiedCount;
  }
  console.log(`Reverted ${reverted} student(s) from ${abs}`);
}

async function runBackfill() {
  const studentsCol = mongoose.connection.db.collection('students');
  // Employee mongoose model maps to `candidates`, not `employees`.
  const employeesCol = mongoose.connection.db.collection('candidates');

  const students = await studentsCol
    .find({ position: null })
    .project({ _id: 1, user: 1 })
    .toArray();

  const resolvable = [];
  const unresolvable = [];

  for (const student of students) {
    if (!student.user) {
      unresolvable.push({ studentId: String(student._id), designation: '(no linked user)' });
      continue;
    }
    const employee = await employeesCol.findOne(
      { owner: student.user },
      { projection: { designation: 1, position: 1, referralJobTitle: 1 } }
    );
    if (!employee) {
      unresolvable.push({ studentId: String(student._id), designation: '(no linked employee)' });
      continue;
    }

    let positionId = employee.position ?? null;
    const titles = getJobTitleCandidates(employee);
    const designationLabel = titles[0] || '(empty designation)';

    if (!positionId) {
      for (const title of titles) {
        // eslint-disable-next-line no-await-in-loop
        positionId = await findPositionIdByTitle(title);
        if (positionId) break;
      }
    }

    if (!positionId) {
      unresolvable.push({ studentId: String(student._id), designation: designationLabel });
      continue;
    }

    resolvable.push({
      studentId: String(student._id),
      from: null,
      to: String(positionId),
      at: new Date().toISOString(),
    });
  }

  console.log(`Students scanned: ${students.length}`);
  console.log(`Resolvable: ${resolvable.length}`);
  console.log(`Unresolvable: ${unresolvable.length}`);
  if (unresolvable.length) {
    console.log('Unresolvable list (studentId, designation):');
    for (const row of unresolvable) {
      console.log(`  ${row.studentId}\t${row.designation}`);
    }
  }

  if (!APPLY) {
    console.log('Dry run — pass --apply to write. No documents were modified.');
    return;
  }

  const journal = [];
  for (const entry of resolvable) {
    const res = await studentsCol.updateOne(
      { _id: new mongoose.Types.ObjectId(entry.studentId), position: null },
      { $set: { position: new mongoose.Types.ObjectId(entry.to) } }
    );
    if (res.modifiedCount) journal.push(entry);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const journalPath = path.join(__dirname, `backfill-student-positions.${stamp}.journal.json`);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  console.log(`Applied ${journal.length} update(s). Journal: ${journalPath}`);
}

async function main() {
  if (!process.env.MONGODB_URL) {
    throw new Error('MONGODB_URL is not set');
  }
  await mongoose.connect(process.env.MONGODB_URL);
  try {
    if (UNDO_PATH) {
      await runUndo(UNDO_PATH);
    } else {
      await runBackfill();
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
