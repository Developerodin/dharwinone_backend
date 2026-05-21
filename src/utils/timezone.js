/**
 * Timezone normalization + rendering. Single source of truth for IANA handling.
 * Backend renders only (UTC instant -> string in a zone); it never converts
 * wall-clock -> UTC (the frontend owns that).
 */

/** Legacy IANA aliases mapped to their canonical names. */
const LEGACY_ALIASES = {
  'Asia/Calcutta': 'Asia/Kolkata',
};

/**
 * @param {*} tz
 * @returns {string} canonical IANA zone, or 'UTC' for empty/invalid input
 */
export const normalizeTimezone = (tz) => {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return 'UTC';
  const trimmed = tz.trim();
  return LEGACY_ALIASES[trimmed] || trimmed;
};

/**
 * @param {string} tz
 * @returns {boolean} whether tz is a zone the runtime's Intl accepts
 */
export const isValidTimezone = (tz) => {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return false;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() });
    formatter.format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const formatterCache = new Map();

const getFormatter = (timeZone, locale) => {
  const key = `${locale}|${timeZone}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
};

/**
 * Render a UTC instant as a human string in the given zone.
 * @param {Date|string|number} instant
 * @param {string} tz - IANA zone (legacy aliases normalized)
 * @param {string} [locale='en-GB']
 * @returns {string}
 */
export const formatInZone = (instant, tz, locale = 'en-GB') => {
  const date = instant instanceof Date ? instant : new Date(instant);
  return getFormatter(normalizeTimezone(tz), locale).format(date);
};

/**
 * Whether the elapsed time since `punchIn` has exceeded `durationHours`.
 * Elapsed time is an absolute interval, so it is timezone-independent; `tz`
 * is accepted for caller-signature compatibility but does not affect the result.
 * @param {Date|string|number} punchIn - punch-in instant
 * @param {string} tz - IANA zone (unused; kept for API compatibility)
 * @param {number} durationHours - threshold in hours
 * @returns {boolean}
 */
// eslint-disable-next-line no-unused-vars
export const hasExceededDurationInTimezone = (punchIn, tz, durationHours) => {
  if (!punchIn || !durationHours || durationHours <= 0) return false;
  const start = punchIn instanceof Date ? punchIn : new Date(punchIn);
  if (isNaN(start.getTime())) return false;
  return Date.now() - start.getTime() >= durationHours * 60 * 60 * 1000;
};
