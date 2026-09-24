/**
 * Intl-only timezone helpers (no tz dependency in this backend).
 * Wall time -> UTC uses a 2-pass offset lookup, which is correct across DST changes
 * except for wall times inside a spring-forward gap (they shift by the gap size).
 */

const dtfCache = new Map();
const getDtf = (tz) => {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
};

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in `tz`. */
export const partsInTz = (date, tz) => {
  const out = {};
  for (const p of getDtf(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday],
  };
};

/** Offset of `tz` from UTC at instant `date`, in minutes (e.g. +330 for Asia/Kolkata). */
export const tzOffsetMinutes = (date, tz) => {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - (date.getTime() - date.getMilliseconds())) / 60000);
};

export const isValidTimeZone = (tz) => {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); // throws RangeError on an unknown zone
    return true;
  } catch {
    return false;
  }
};

/** 'YYYY-MM-DD' + 'HH:mm' as wall time in `tz` -> UTC Date. */
export const zonedWallTimeToUtc = (dateStr, timeStr, tz) => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(new Date(naive), tz);
  let guess = naive - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(guess), tz);
  if (off2 !== off1) guess = naive - off2 * 60000;
  return new Date(guess);
};

/** 'YYYY-MM-DD' of `date` in `tz`. */
export const dateStrInTz = (date, tz) => {
  const p = partsInTz(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** 0=Sun..6=Sat of a calendar date string (tz-independent). */
export const dayOfWeekOfDateStr = (dateStr) => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
};

/** 0=Sun..6=Sat of `date` as seen in `tz`. */
export const dayOfWeekInTz = (date, tz) => partsInTz(date, tz).weekday;

/** Calendar date string + n days. */
export const addDaysToDateStr = (dateStr, n) => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
};
