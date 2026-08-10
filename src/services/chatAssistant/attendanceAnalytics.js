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

/**
 * BackdatedAttendanceRequest window — matches when any attendanceEntries.date
 * falls in the inclusive window. Prefer entry dates over createdAt so
 * "backdated punches in July" counts July workdays, not filing date.
 * @param {{ from: Date|null, to: Date|null }|null} window
 * @returns {object|null}
 */
export function backdatedEntriesWindowClause(window) {
  if (!window?.from && !window?.to) return null;
  const range = {};
  if (window.from) range.$gte = window.from;
  if (window.to) range.$lte = window.to;
  return { 'attendanceEntries.date': range };
}

/** Being absent on leave, however the user phrases it. */
const OFF_TODAY_SUBJECT_RE = /\b(on\s+leave|leaves?|time\s*off|off|away|absent|out\s+of\s+office|ooo)\b/i;
/** Anchored to now — the whole point of the on_leave_today tool. */
const TODAY_CUE_RE = /\b(today|todays|today's|today’s|right\s+now|currently|at\s+the\s+moment|as\s+of\s+now)\b/i;

/**
 * True when the ask is "who is on leave today".
 *
 * Routes to on_leave_today, which reads the Attendance ledger. Checked in
 * detectIntent BEFORE both SPECIFIC_LOOKUP_RE and the generic INTENT_PATTERNS
 * list: "today's leaves" otherwise trips the "<name>'s leaves" possessive rule,
 * and every other phrasing gets swallowed by the catch-all leave rule and
 * answered from the leave-REQUEST queue — a filing with an approval status,
 * which is not the same thing as being absent today.
 *
 * Requires BOTH a leave/off subject and a now-anchor, so "pending leaves" and
 * "who joined today" are left alone.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeOnLeaveTodayQuery(text) {
  if (!text || typeof text !== 'string') return false;
  if (!TODAY_CUE_RE.test(text) || !OFF_TODAY_SUBJECT_RE.test(text)) return false;
  // "most leaves today" is a ranking question that happens to be scoped to
  // today — leaveRanking.looksLikeLeaveRankingQuery owns it.
  if (/\b(most|highest|top|fewest|least|rank(ed|ing)?)\b/i.test(text)) return false;
  return true;
}

/**
 * True when the ask is about a person's week-off or group memberships —
 * must route to fetch_employee_overview (not org-wide attendance sum).
 * @param {string} text
 */
export function looksLikeWeekOffOrGroupsQuery(text) {
  if (!text) return false;
  return /\b(week[\s-]?offs?|off[\s-]?days?|weekend\s+off|which\s+days?\s+off)\b/i.test(text)
    || /\b(candidate\s+groups?|student\s+groups?|group\s+memberships?|what\s+groups?)\b/i.test(text);
}
