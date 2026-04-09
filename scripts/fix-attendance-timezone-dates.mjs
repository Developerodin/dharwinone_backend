/**
 * Migration script: recompute attendance `date` and `day` fields using the correct timezone.
 *
 * Before this fix, the backend derived date/day from UTC components of the punch-in instant,
 * causing day-date mismatches for non-UTC timezones (e.g. IST punch on Monday stored as Sunday).
 *
 * This script reads every attendance record, resolves the effective timezone (from the linked
 * student's shift, or the record's own `timezone` field, or 'UTC'), and recomputes:
 *   - date: UTC midnight of the LOCAL calendar date  (Date.UTC(localY, localM, localD))
 *   - day:  local weekday name                       ("Monday", "Tuesday", etc.)
 *
 * DRY RUN by default — set DRY_RUN=false to apply changes.
 *
 * Usage:
 *   node scripts/fix-attendance-timezone-dates.mjs              # dry run
 *   DRY_RUN=false node scripts/fix-attendance-timezone-dates.mjs  # apply
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.DRY_RUN !== 'false';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getLocalMidnightAndDay(instant, timezone) {
  const tz = timezone && timezone.trim() ? timezone.trim() : 'UTC';
  const d = new Date(instant);
  if (tz === 'UTC') {
    return {
      midnight: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
      day: DAY_NAMES[d.getUTCDay()],
    };
  }
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dateFmt.formatToParts(d);
  const getPart = (name) => parts.find((p) => p.type === name)?.value;
  const y = parseInt(getPart('year'), 10);
  const m = parseInt(getPart('month'), 10) - 1;
  const dd = parseInt(getPart('day'), 10);

  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const day = weekdayFmt.format(d);

  const midnight = new Date(Date.UTC(y, m, dd));
  return { midnight, day };
}

const attendanceSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    date: Date,
    day: String,
    punchIn: Date,
    punchOut: Date,
    timezone: String,
    status: String,
    isActive: Boolean,
  },
  { collection: 'attendances', strict: false }
);
const Attendance = mongoose.model('AttendanceMigration', attendanceSchema);

const studentSchema = new mongoose.Schema(
  { shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' } },
  { collection: 'students', strict: false }
);
const Student = mongoose.model('StudentMigration', studentSchema);

const shiftSchema = new mongoose.Schema(
  { timezone: String },
  { collection: 'shifts', strict: false }
);
const Shift = mongoose.model('ShiftMigration', shiftSchema);

async function main() {
  const url = process.env.MONGODB_URL;
  if (!url) {
    console.error('MONGODB_URL missing in .env');
    process.exit(1);
  }

  console.log(`Connecting to MongoDB…`);
  await mongoose.connect(url);
  console.log(`Connected. DRY_RUN=${DRY_RUN}\n`);

  // Pre-load all shifts so we can resolve student → shift timezone
  const shifts = await Shift.find({}).lean();
  const shiftById = new Map(shifts.map((s) => [s._id.toString(), s]));

  // Pre-load all students to map student → shift timezone
  const students = await Student.find({}).select('shift').lean();
  const studentShiftTz = new Map();
  for (const s of students) {
    if (s.shift) {
      const shift = shiftById.get(s.shift.toString());
      if (shift?.timezone) {
        studentShiftTz.set(s._id.toString(), shift.timezone);
      }
    }
  }

  console.log(`Loaded ${shifts.length} shifts, ${students.length} students`);

  const BATCH_SIZE = 500;
  let processed = 0;
  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  const cursor = Attendance.find({}).sort({ _id: 1 }).lean().cursor({ batchSize: BATCH_SIZE });

  const bulkOps = [];

  for await (const record of cursor) {
    processed++;

    if (!record.punchIn) {
      skipped++;
      continue;
    }

    try {
      // Resolve timezone: student shift > record timezone > UTC
      let effectiveTz = 'UTC';
      if (record.student) {
        const shiftTz = studentShiftTz.get(record.student.toString());
        if (shiftTz) effectiveTz = shiftTz;
        else if (record.timezone && record.timezone.trim()) effectiveTz = record.timezone.trim();
      } else if (record.timezone && record.timezone.trim()) {
        effectiveTz = record.timezone.trim();
      }

      const { midnight, day } = getLocalMidnightAndDay(record.punchIn, effectiveTz);

      const storedDate = record.date ? new Date(record.date).getTime() : null;
      const storedDay = record.day || '';
      const newDate = midnight.getTime();
      const newDay = day;

      const dateChanged = storedDate !== newDate;
      const dayChanged = storedDay !== newDay;

      if (dateChanged || dayChanged) {
        fixed++;
        if (!DRY_RUN) {
          bulkOps.push({
            updateOne: {
              filter: { _id: record._id },
              update: { $set: { date: midnight, day: newDay } },
            },
          });
          if (bulkOps.length >= BATCH_SIZE) {
            await Attendance.bulkWrite(bulkOps);
            bulkOps.length = 0;
          }
        }
        if (fixed <= 20) {
          const oldDateStr = record.date ? new Date(record.date).toISOString().slice(0, 10) : 'null';
          const newDateStr = midnight.toISOString().slice(0, 10);
          console.log(
            `  FIX #${fixed}: id=${record._id} tz=${effectiveTz} ` +
            `date: ${oldDateStr} → ${newDateStr}, day: "${storedDay}" → "${newDay}"`
          );
        }
      }
    } catch (err) {
      errors++;
      if (errors <= 10) {
        console.error(`  ERROR: id=${record._id} — ${err.message}`);
      }
    }

    if (processed % 5000 === 0) {
      console.log(`  … processed ${processed}, fixed ${fixed}, errors ${errors}`);
    }
  }

  // Flush remaining bulk ops
  if (!DRY_RUN && bulkOps.length > 0) {
    await Attendance.bulkWrite(bulkOps);
  }

  console.log(`\nDone.`);
  console.log(`  Total processed: ${processed}`);
  console.log(`  Fixed:           ${fixed}`);
  console.log(`  Skipped (no punchIn): ${skipped}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  DRY_RUN:         ${DRY_RUN}`);
  if (DRY_RUN && fixed > 0) {
    console.log(`\n  Re-run with DRY_RUN=false to apply changes.`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
