/**
 * Shared Employee-collection filters for list + analytics tools.
 * Population must already be scoped to Employee-role owners via employeeOwnerQuery.
 */

/**
 * @param {'active'|'resigned'|'all'} employmentStatus
 * @param {Date} [today]
 */
export function employmentStatusClause(employmentStatus, today = new Date()) {
  if (employmentStatus === 'resigned') {
    return { resignDate: { $ne: null, $lte: today } };
  }
  if (employmentStatus === 'all') {
    return {};
  }
  // active (default)
  return {
    $or: [
      { resignDate: null },
      { resignDate: { $exists: false } },
      { resignDate: { $gt: today } },
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
    const clause = { resignDate: { $ne: null } };
    if (from || to) {
      clause.resignDate = { $ne: null };
      if (from) clause.resignDate.$gte = from;
      if (to) clause.resignDate.$lte = to;
    } else {
      clause.resignDate.$lte = today;
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
