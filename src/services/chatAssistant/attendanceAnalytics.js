/**
 * Epic B — Attendance analytics helpers.
 * Avg daily Present MUST be computed here (never by the LLM summing perDay rows).
 */

/**
 * Average daily Present headcount across an aggregateOrgAttendance `perDay` array.
 * Future calendar days are excluded by default so an open-ended month does not
 * dilute the average with zeros that have not happened yet.
 *
 * @param {Array<{ date: string, counts?: { Present?: number } }>} perDay
 * @param {{ excludeFuture?: boolean, todayIso?: string }} [opts]
 * @returns {{ avgDailyPresent: number, dayCount: number, totalPresent: number }}
 */
export function computeAvgDailyPresent(perDay, opts = {}) {
  const excludeFuture = opts.excludeFuture !== false;
  const todayIso = opts.todayIso || new Date().toISOString().slice(0, 10);
  const days = Array.isArray(perDay) ? perDay : [];
  const usable = excludeFuture
    ? days.filter((d) => d?.date && String(d.date) <= todayIso)
    : days;
  const totalPresent = usable.reduce(
    (sum, d) => sum + Number(d?.counts?.Present || 0),
    0
  );
  const dayCount = usable.length;
  const avgDailyPresent = dayCount
    ? Math.round((totalPresent / dayCount) * 100) / 100
    : 0;
  return { avgDailyPresent, dayCount, totalPresent };
}

/**
 * Enrich aggregateOrgAttendance result with authoritative avg-daily Present.
 * @param {object} result
 * @param {{ todayIso?: string }} [opts]
 */
export function enrichAttendanceSummary(result, opts = {}) {
  if (!result || result.notFound || result.needsTimeWindow) return result;
  const stats = computeAvgDailyPresent(result.perDay, opts);
  return {
    ...result,
    ...stats,
    authoritative: true,
  };
}

/**
 * LeaveRequest window clause — matches requests with at least one leave day
 * inside the inclusive resolveDateWindow range.
 *
 * Uses `$elemMatch` so both bounds bind to the SAME element of the `dates`
 * array. A bare `{ dates: { $gte, $lte } }` lets Mongo satisfy each operator
 * with a *different* element, so a request running 2026-07-23 → 2026-08-31
 * matched any single-day window in between (some date >= from, some other
 * date <= to) even when no leave day was actually booked on that day.
 *
 * @param {{ from: Date|null, to: Date|null }|null} window
 * @returns {object|null} mongo clause fragment, or null when no window
 */
export function leaveDatesWindowClause(window) {
  if (!window?.from && !window?.to) return null;
  const range = {};
  if (window.from) range.$gte = window.from;
  if (window.to) range.$lte = window.to;
  return { dates: { $elemMatch: range } };
}
