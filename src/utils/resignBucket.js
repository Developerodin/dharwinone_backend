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
