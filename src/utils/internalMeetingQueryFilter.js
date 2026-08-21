const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MONTH_ALIASES = [
  ['jan', 'january'],
  ['feb', 'february'],
  ['mar', 'march'],
  ['apr', 'april'],
  ['may', 'may'],
  ['jun', 'june'],
  ['jul', 'july'],
  ['aug', 'august'],
  ['sep', 'september'],
  ['oct', 'october'],
  ['nov', 'november'],
  ['dec', 'december'],
];

function dayRangeFromDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Best-effort parse of free-text date fragments used in the meetings search bar.
 * Supports ISO dates, locale-style dates, and month/day phrases like "Aug 20".
 *
 * @param {string} term
 * @returns {{ start: Date, end: Date } | null}
 */
export function tryBuildDateRangeFromSearch(term) {
  const trimmed = String(term ?? '').trim();
  if (!trimmed || trimmed.length < 2) return null;

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return dayRangeFromDate(parsed);
  }

  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return dayRangeFromDate(parsed);
  }

  const lower = trimmed.toLowerCase();
  for (let monthIndex = 0; monthIndex < MONTH_ALIASES.length; monthIndex += 1) {
    const aliases = MONTH_ALIASES[monthIndex];
    const monthPattern = aliases.map((alias) => escapeRegex(alias)).join('|');
    const dayMatch = lower.match(new RegExp(`^(?:${monthPattern})\\s+(\\d{1,2})(?:\\s|,|$)`));
    if (dayMatch) {
      const year = new Date().getFullYear();
      const parsed = new Date(year, monthIndex, Number(dayMatch[1]));
      if (!Number.isNaN(parsed.getTime())) return dayRangeFromDate(parsed);
    }

    const reverseDayMatch = lower.match(new RegExp(`^(\\d{1,2})\\s+(?:${monthPattern})(?:\\s|,|$)`));
    if (reverseDayMatch) {
      const year = new Date().getFullYear();
      const parsed = new Date(year, monthIndex, Number(reverseDayMatch[1]));
      if (!Number.isNaN(parsed.getTime())) return dayRangeFromDate(parsed);
    }

    if (aliases.some((alias) => lower === alias)) {
      const year = new Date().getFullYear();
      const start = new Date(year, monthIndex, 1);
      const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
      return { start, end };
    }
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed) && /[a-z]/i.test(trimmed)) {
    return dayRangeFromDate(new Date(parsed));
  }

  return null;
}

/**
 * Build a Mongo filter for internal meeting list/search.
 * Supports title/participant/email/date search via `search` (or legacy `title`)
 * and explicit date-range filtering via `dateFrom` / `dateTo`.
 *
 * @param {Record<string, any>} query
 * @returns {Record<string, any>}
 */
export function buildInternalMeetingsMongoFilter(query = {}) {
  const and = [];
  const filter = {};

  const status = String(query.status ?? '').trim();
  if (status) {
    and.push({ status: { $regex: new RegExp(`^${escapeRegex(status)}$`, 'i') } });
  }

  const searchTerm = String(query.search ?? query.title ?? '').trim();
  if (searchTerm) {
    const re = { $regex: escapeRegex(searchTerm), $options: 'i' };
    const orClauses = [
      { title: re },
      { 'hosts.nameOrRole': re },
      { 'hosts.email': re },
      { emailInvites: re },
    ];

    const dateRange = tryBuildDateRangeFromSearch(searchTerm);
    if (dateRange) {
      orClauses.push({
        scheduledAt: { $gte: dateRange.start, $lte: dateRange.end },
      });
    }

    and.push({ $or: orClauses });
  }

  // Explicit date-range filter (from the filter sheet).
  const dateFrom = query.dateFrom ? new Date(query.dateFrom) : null;
  const dateTo = query.dateTo ? new Date(query.dateTo) : null;
  if (dateFrom || dateTo) {
    const scheduledAtFilter = {};
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
      const start = new Date(dateFrom);
      start.setHours(0, 0, 0, 0);
      scheduledAtFilter.$gte = start;
    }
    if (dateTo && !Number.isNaN(dateTo.getTime())) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      scheduledAtFilter.$lte = end;
    }
    if (Object.keys(scheduledAtFilter).length) {
      and.push({ scheduledAt: scheduledAtFilter });
    }
  }

  if (and.length) {
    filter.$and = and;
  }

  return filter;
}
