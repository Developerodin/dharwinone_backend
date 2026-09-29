export const RESIGN_SOON_WINDOW_DAYS = 30;

/**
 * Bucket an employee's resignDate relative to `now`.
 * Pure: `now` is always passed in. Mirrors employee.service.js current/resigned semantics.
 * @param {Date|string|null|undefined} resignDate
 * @param {Date} now
 * @returns {'soon'|'resigned'|null}
 */
export const resignBucket = (resignDate, now) => {
  if (!resignDate) return null;
  const rd = new Date(resignDate);
  if (Number.isNaN(rd.getTime())) return null;
  if (rd.getTime() <= now.getTime()) return 'resigned';
  const windowEnd = now.getTime() + RESIGN_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return rd.getTime() <= windowEnd ? 'soon' : null;
};

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
