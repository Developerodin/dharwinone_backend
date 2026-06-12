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

const offsetFormatterCache = new Map();

const getOffsetFormatter = (timeZone) => {
  let formatter = offsetFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatterCache.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * Offset (ms) of `timeZone` at a given UTC instant: localWallClock - utc.
 * Positive east of UTC (e.g. Asia/Kolkata → +19800000).
 */
const tzOffsetMs = (utcMs, timeZone) => {
  const parts = getOffsetFormatter(timeZone).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Intl can emit hour '24' at midnight — normalize to 0.
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second)
  );
  return asUTC - utcMs;
};

/**
 * Convert wall-clock parts in a zone to the matching UTC instant. DST-correct
 * (resolves the offset at the target instant, with a second pass across a DST
 * boundary). Mirrors the frontend `wallClockToUtc` so recurrence occurrences are
 * anchored to the user's intended local time.
 * @param {{year:number,month:number,day:number,hour?:number,minute?:number,second?:number}} parts - month is 1-based
 * @param {string} tz - IANA zone (legacy aliases normalized)
 * @returns {Date}
 */
export const wallClockToUtc = (parts, tz) => {
  const zone = normalizeTimezone(tz);
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naiveUtc - tzOffsetMs(naiveUtc, zone);
  // Re-resolve once: across a DST transition the first offset guess can be wrong.
  const refined = tzOffsetMs(ts, zone);
  ts = naiveUtc - refined;
  return new Date(ts);
};

/**
 * Wall-clock parts of a UTC instant as seen in a zone (inverse of wallClockToUtc).
 * @param {Date|string|number} instant
 * @param {string} tz
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}} month is 1-based
 */
export const wallClockPartsInZone = (instant, tz) => {
  const zone = normalizeTimezone(tz);
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = getOffsetFormatter(zone).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
};
