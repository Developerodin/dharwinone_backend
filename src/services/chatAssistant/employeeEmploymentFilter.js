/**
 * Shared Employee-collection filters for list + analytics tools.
 *
 * Population note: callers scope owners two different ways —
 *   - analytics (managerCounts, peopleFetcher) → employeeOwnerQuery (pure query,
 *     honours chatbot.visibility.includeDisabled)
 *   - entityQuery / REST list → ensureProfilesForActiveAtsRoleUsers
 *     (employee.service.js:610) which also CREATES missing profiles and hardcodes
 *     status active|pending
 * Measured 2026-08-10: identical result sets (189/189) under default config; they
 * diverge by exactly the disabled Employee-role users when includeDisabled is on.
 * They are NOT interchangeable — one performs writes. Do not merge without reading
 * docs/superpowers/plans/2026-08-10-entityquery-remediation.md Task 18.
 */

/**
 * The single day boundary for resignation classification.
 *
 * resignDate is stored date-only in UTC while the server runs IST, so comparing
 * it to a local midnight or to `now` gives different answers for ~18.5h on the
 * resign date itself. This helper is the ONE place that decision lives.
 *
 * Product decision 2026-08-10: an employee counts as resigned for the whole
 * calendar day of their resignDate (UTC date boundary).
 *
 * @param {Date} [now]
 * @returns {Date} the instant at which a resignDate counts as past
 */
export function resignationCutoff(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}

/**
 * @param {'active'|'resigned'|'all'} employmentStatus
 * @param {Date} [today]
 */
export function employmentStatusClause(employmentStatus, today = new Date()) {
  const cutoff = resignationCutoff(today);
  if (employmentStatus === 'resigned') {
    return { resignDate: { $ne: null, $lte: cutoff } };
  }
  if (employmentStatus === 'all') {
    return {};
  }
  // active (default)
  return {
    $or: [
      { resignDate: null },
      { resignDate: { $exists: false } },
      { resignDate: { $gt: cutoff } },
    ],
  };
}

/**
 * Date-field window filter. `from`/`to` are inclusive (resolveDateWindow EOD).
 * @param {'resign'|'join'|'headcount'} metric
 * @param {{ from: Date|null, to: Date|null }} window
 * @param {Date} [today]
 */
export function employmentMetricClause(metric, window, today = new Date()) {
  const from = window?.from || null;
  const to = window?.to || null;

  if (metric === 'resign') {
    const cutoff = resignationCutoff(today);
    const clause = { resignDate: { $ne: null } };
    if (from || to) {
      clause.resignDate = { $ne: null };
      if (from) clause.resignDate.$gte = from;
      if (to) clause.resignDate.$lte = to;
    } else {
      clause.resignDate.$lte = cutoff;
    }
    return clause;
  }

  if (metric === 'join') {
    const clause = { joiningDate: { $ne: null } };
    if (from) clause.joiningDate = { ...(clause.joiningDate || {}), $ne: null, $gte: from };
    if (to) clause.joiningDate = { ...(clause.joiningDate || { $ne: null }), $lte: to };
    if (!from && !to) {
      // No window → all with a joiningDate (caller should usually require a window)
      return { joiningDate: { $ne: null } };
    }
    return clause;
  }

  // headcount as-of end of window (or today): employed on that day
  const asOf = to || today;
  return {
    $and: [
      {
        $or: [
          { joiningDate: null },
          { joiningDate: { $exists: false } },
          { joiningDate: { $lte: asOf } },
        ],
      },
      {
        $or: [
          { resignDate: null },
          { resignDate: { $exists: false } },
          { resignDate: { $gt: asOf } },
        ],
      },
    ],
  };
}

/**
 * Paid / unpaid filter — Employee profile field only. Callers MUST already
 * restrict owners to the Employee role (never Candidate / ATS population).
 * @param {'paid'|'unpaid'|null|undefined} compensationType
 */
export function compensationTypeClause(compensationType) {
  if (!compensationType) return {};
  const v = String(compensationType).trim().toLowerCase();
  if (v !== 'paid' && v !== 'unpaid') return {};
  return { compensationType: v };
}

/**
 * Compose a full Employee mongo filter for analytics / list reuse.
 *
 * @param {{
 *   ownerIds: any[],
 *   metric?: 'resign'|'join'|'headcount'|null,
 *   employmentStatus?: 'active'|'resigned'|'all'|null,
 *   window?: { from: Date|null, to: Date|null },
 *   compensationType?: 'paid'|'unpaid'|null,
 *   today?: Date,
 * }} opts
 */
export function buildEmployeeEmploymentFilter(opts = {}) {
  const {
    ownerIds,
    metric = null,
    employmentStatus = null,
    window = null,
    compensationType = null,
    today = new Date(),
  } = opts;

  const parts = [];
  if (ownerIds) {
    parts.push({ owner: { $in: ownerIds } });
  }

  if (metric) {
    parts.push(employmentMetricClause(metric, window || {}, today));
  } else if (employmentStatus) {
    parts.push(employmentStatusClause(employmentStatus, today));
  }

  const comp = compensationTypeClause(compensationType);
  if (Object.keys(comp).length) parts.push(comp);

  if (!parts.length) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}
