/**
 * Repair days left double-counted by the old backdated-approve write path.
 *
 * Why it is needed: approve used a single `findOne` and rewrote one arbitrary Attendance row
 * for the day. `punchIn` files every completed session as its own row, so any session already
 * on that day survived the approval. The calendar sums sessions per day, so an approved
 * 09:00–17:00 request could render as 16h — clamped by the client to a flat "14h 0m".
 * The service now claims the whole day; already-approved days still carry the strays.
 *
 * Safety: a day with several punch sessions is NORMAL and must not be touched. This script
 * only considers days that were *regularized* — days named by an approved backdated request —
 * and only there treats the extra rows as leftovers. Nothing else is examined.
 *
 * The surviving row is picked with the same rule the service now uses (active first, then
 * earliest punch-in) so a repaired day matches what a fresh approval would produce. Rows are
 * deactivated, never deleted, so a wrong call is undone by flipping isActive back.
 *
 * Idempotent: a day whose extras are already inactive reports nothing to do.
 *
 * Usage:
 *   node scripts/migrations/2026-09-10-collapse-backdated-duplicate-days.js          # dry-run
 *   node scripts/migrations/2026-09-10-collapse-backdated-duplicate-days.js --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();
const APPLY = process.argv.includes('--apply');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Pure: worked milliseconds a row contributes to its day, mirroring the client's
 * sessionDurationMsForDisplay (stored duration first, punch span as fallback).
 * Holiday/Leave rows contribute nothing.
 * @param {Object} row
 * @returns {number}
 */
export function workedMs(row) {
  if (row?.status === 'Holiday' || row?.status === 'Leave') return 0;
  const stored = typeof row?.duration === 'number' && row.duration > 0 ? row.duration : null;
  if (stored != null) return stored;
  if (!row?.punchIn || !row?.punchOut) return 0;
  const span = new Date(row.punchOut).getTime() - new Date(row.punchIn).getTime();
  return span > 0 ? span : 0;
}

/**
 * Pure: order rows the way the service picks a survivor — active first, then earliest punch-in.
 * @param {Array<Object>} rows
 * @returns {Array<Object>} a new array; rows[0] is the one to keep
 */
export function orderBySurvivor(rows) {
  return [...rows].sort((a, b) => {
    if (Boolean(b.isActive) !== Boolean(a.isActive)) return Number(Boolean(b.isActive)) - Number(Boolean(a.isActive));
    return new Date(a.punchIn ?? 0).getTime() - new Date(b.punchIn ?? 0).getTime();
  });
}

/** UTC midnight for a stored attendance date. */
const dayKey = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db;
  const requests = db.collection('backdatedattendancerequests');
  const attendances = db.collection('attendances');

  const approved = await requests
    .find({ status: 'approved' })
    .project({ student: 1, user: 1, 'attendanceEntries.date': 1 })
    .toArray();

  // Every (owner, day) an approved request claims. Deduped: two requests can name one day.
  const claimed = new Map();
  for (const req of approved) {
    const owner = req.user != null ? { field: 'user', id: req.user } : { field: 'student', id: req.student };
    if (owner.id == null) continue;
    for (const entry of req.attendanceEntries ?? []) {
      if (!entry?.date) continue;
      const day = dayKey(entry.date);
      claimed.set(`${owner.field}:${owner.id}:${day.getTime()}`, { owner, day });
    }
  }

  console.log(`${approved.length} approved request(s) covering ${claimed.size} regularized day(s)`);

  const repairs = [];
  for (const { owner, day } of claimed.values()) {
    const nextDay = new Date(day);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const rows = await attendances
      .find({ [owner.field]: owner.id, date: { $gte: day, $lt: nextDay }, isActive: true })
      .project({ date: 1, punchIn: 1, punchOut: 1, duration: 1, status: 1, isActive: 1 })
      .toArray();
    if (rows.length < 2) continue;

    const ordered = orderBySurvivor(rows);
    const totalHours = rows.reduce((sum, r) => sum + workedMs(r), 0) / HOUR_MS;
    const keptHours = workedMs(ordered[0]) / HOUR_MS;
    repairs.push({
      owner,
      day,
      supersede: ordered.slice(1).map((r) => r._id),
      totalHours: Math.round(totalHours * 100) / 100,
      keptHours: Math.round(keptHours * 100) / 100,
    });
  }

  if (repairs.length === 0) {
    console.log('No regularized day carries leftover sessions. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${repairs.length} regularized day(s) still carry leftover sessions:\n`);
  for (const r of repairs) {
    console.log(
      `  ${r.day.toISOString().slice(0, 10)}  ${r.owner.field}=${r.owner.id}  ` +
        `${r.totalHours}h across ${r.supersede.length + 1} rows -> ${r.keptHours}h on 1 row`
    );
  }

  if (!APPLY) {
    console.log('\nDry run — pass --apply to deactivate the leftover rows.');
    await mongoose.disconnect();
    return;
  }

  let deactivated = 0;
  for (const r of repairs) {
    const res = await attendances.updateMany({ _id: { $in: r.supersede } }, { $set: { isActive: false } });
    deactivated += res.modifiedCount;
  }
  console.log(`\nDeactivated ${deactivated} leftover row(s) across ${repairs.length} day(s).`);
  await mongoose.disconnect();
}

// Importable for tests; only connects when run directly.
if (process.argv[1] && process.argv[1].endsWith('2026-09-10-collapse-backdated-duplicate-days.js')) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
