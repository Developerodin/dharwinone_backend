/**
 * One-off: cap impossible per-session durations (forgotten punch-out, bad imports, TZ bugs).
 * Uses ATTENDANCE_MAX_SESSION_HOURS (default 24) — same as runtime clamp.
 *
 * Run: node scripts/clamp-attendance-durations.js
 * Requires: .env with MONGODB_URL
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import Attendance from '../src/models/attendance.model.js';
import { effectiveSessionDurationMs, getMaxSessionDurationMs } from '../src/utils/attendanceDuration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const MONGODB_URL = process.env.MONGODB_URL;
  if (!MONGODB_URL) {
    console.error('MONGODB_URL is required');
    process.exit(1);
  }

  const maxMs = getMaxSessionDurationMs();
  console.log(`Using max session duration: ${maxMs / 3600000}h (${maxMs} ms)`);

  await mongoose.connect(MONGODB_URL);
  const filter = {
    isActive: true,
    punchOut: { $ne: null },
    punchIn: { $exists: true },
    $or: [{ duration: { $gt: maxMs } }, { $expr: { $gt: [{ $subtract: ['$punchOut', '$punchIn'] }, maxMs] } }],
  };

  const count = await Attendance.countDocuments(filter);
  console.log(`Documents to fix: ${count}`);

  const cursor = Attendance.find(filter).select('_id punchIn punchOut duration').cursor();
  let updated = 0;
  for await (const doc of cursor) {
    const lean = doc.toObject ? doc.toObject() : doc;
    const next = effectiveSessionDurationMs(lean);
    if (next == null || next === lean.duration) continue;
    await Attendance.updateOne({ _id: doc._id }, { $set: { duration: next } });
    updated += 1;
    if (updated % 100 === 0) console.log(`  updated ${updated}...`);
  }

  console.log(`Done. Updated ${updated} attendance record(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
