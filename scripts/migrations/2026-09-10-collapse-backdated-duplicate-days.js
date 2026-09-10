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
 * Pure: the row approve actually wrote, identified by the punch times the request asked for.
 *
 * Do NOT guess the survivor. An earlier draft sorted by punch-in and kept the earliest, which
 * on a day carrying an `assignHolidays` duplicate picks the Holiday row — created with
 * punchIn at UTC midnight, so it always sorts first — and would have deactivated the real
 * work row. The request records the exact instants approve stored, so match on those and
 * refuse the day when nothing matches.
 *
 * @param {Array<Object>} rows
 * @param {{punchIn: Date, punchOut: Date|null}} expected
 * @returns {{keep: Object, supersede: Array<Object>} | null} null when no row matches
 */
export function pickWrittenRow(rows, expected) {
  const at = (v) => (v == null ? null : new Date(v).getTime());
  const wantIn = at(expected?.punchIn);
  if (wantIn == null) return null;
  const wantOut = at(expected?.punchOut);

  const matches = rows.filter((r) => at(r.punchIn) === wantIn && (wantOut == null || at(r.punchOut) === wantOut));
  if (matches.length === 0) return null;

  const keep = matches[0];
  return { keep, supersede: rows.filter((r) => r !== keep) };
}

/** A day carrying a Holiday or Leave row is a different bug (assignHolidays) — never touch it. */
export function hasHolidayOrLeave(rows) {
  return rows.some((r) => r.status === 'Holiday' || r.status === 'Leave');
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

  // Oldest first: when two approved requests name the same day, the later approval is the one
  // whose times are on the row, so it must be the entry that survives in the map.
  const approved = await requests
    .find({ status: 'approved' })
    .project({ student: 1, user: 1, reviewedAt: 1, attendanceEntries: 1 })
    .sort({ reviewedAt: 1 })
    .toArray();

  // Every (owner, day) an approved request claims, with the punch times approve wrote there.
  const claimed = new Map();
  for (const req of approved) {
    const owner = req.user != null ? { field: 'user', id: req.user } : { field: 'student', id: req.student };
    if (owner.id == null) continue;
    for (const entry of req.attendanceEntries ?? []) {
      if (!entry?.date) continue;
      const day = dayKey(entry.date);
      claimed.set(`${owner.field}:${owner.id}:${day.getTime()}`, {
        owner,
        day,
        punchIn: entry.punchIn,
        punchOut: entry.punchOut ?? null,
      });
    }
  }

  console.log(`${approved.length} approved request(s) covering ${claimed.size} regularized day(s)`);

  // One aggregation, not one query per day. Group every active row on those calendar dates by
  // (owner, day) and keep only the groups holding more than one row; the claimed-set filter
  // then drops days belonging to people who were never regularized.
  //
  // ponytail: `$in` on exact UTC midnights, matching how the app stores and queries the day
  // (findBlockedAttendanceDays does the same) and letting the {student,date}/{user,date}
  // indexes serve it. A legacy row whose `date` carries a time component would be missed —
  // widen to a range match plus $dateToString grouping if such rows ever turn up.
  const distinctDates = [...new Set([...claimed.values()].map(({ day }) => day.getTime()))].map((t) => new Date(t));
  console.log(`scanning ${distinctDates.length} distinct calendar date(s)…`);

  const groups = await attendances
    .aggregate(
      [
        { $match: { isActive: true, date: { $in: distinctDates } } },
        {
          $group: {
            _id: { student: '$student', user: '$user', date: '$date' },
            rows: {
              $push: { _id: '$_id', punchIn: '$punchIn', punchOut: '$punchOut', duration: '$duration', status: '$status', isActive: '$isActive' },
            },
            n: { $sum: 1 },
          },
        },
        { $match: { n: { $gte: 2 } } },
      ],
      { allowDiskUse: true }
    )
    .toArray();

  const repairs = [];
  const holidayCollisions = [];
  const unmatched = [];
  for (const group of groups) {
    const owner = group._id.user != null ? { field: 'user', id: group._id.user } : { field: 'student', id: group._id.student };
    if (owner.id == null) continue;
    const day = dayKey(group._id.date);
    // Only days an approved backdated request actually named. A day with several punch
    // sessions is normal; the leftovers are only leftovers where approve rewrote the day.
    const expected = claimed.get(`${owner.field}:${owner.id}:${day.getTime()}`);
    if (!expected) continue;

    const totalHours = Math.round((group.rows.reduce((sum, r) => sum + workedMs(r), 0) / HOUR_MS) * 100) / 100;
    const label = `${day.toISOString().slice(0, 10)}  ${owner.field}=${owner.id}`;

    // A Holiday or Leave row beside a worked row is assignHolidays inserting a duplicate, not
    // an approve leftover. Which one should win is a policy call — report, never touch.
    if (hasHolidayOrLeave(group.rows)) {
      holidayCollisions.push({ label, rows: group.rows.length, totalHours });
      continue;
    }

    const picked = pickWrittenRow(group.rows, expected);
    if (!picked) {
      unmatched.push({ label, rows: group.rows.length, totalHours });
      continue;
    }

    repairs.push({
      label,
      day,
      supersede: picked.supersede.map((r) => r._id),
      totalHours,
      keptHours: Math.round((workedMs(picked.keep) / HOUR_MS) * 100) / 100,
    });
  }
  repairs.sort((a, b) => a.day - b.day);

  if (holidayCollisions.length > 0) {
    console.log(
      `\n${holidayCollisions.length} day(s) carry a Holiday/Leave row beside a worked row — NOT touched.` +
        `\nThat is the assignHolidays duplicate-insert bug; deciding which row wins is a policy call.\n`
    );
    for (const c of holidayCollisions) console.log(`  ${c.label}  ${c.totalHours}h across ${c.rows} rows`);
  }

  if (unmatched.length > 0) {
    console.log(
      `\n${unmatched.length} day(s) have extra rows but none matching the approved punch times — NOT touched.\n`
    );
    for (const u of unmatched) console.log(`  ${u.label}  ${u.totalHours}h across ${u.rows} rows`);
  }

  if (repairs.length === 0) {
    console.log('\nNo regularized day carries an attributable leftover session. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${repairs.length} regularized day(s) still carry leftover sessions:\n`);
  for (const r of repairs) {
    console.log(`  ${r.label}  ${r.totalHours}h across ${r.supersede.length + 1} rows -> ${r.keptHours}h on 1 row`);
    // The undo list. Deactivation is only reversible if the operator knows which rows moved,
    // so the ids are printed before anything is written, dry run included.
    console.log(`      deactivates: ${r.supersede.join(', ')}`);
  }
  console.log('\nUndo: db.attendances.updateMany({_id:{$in:[<ids above>]}}, {$set:{isActive:true}})');

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
