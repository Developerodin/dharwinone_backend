// Map natural-language date phrases → args for resolveDateWindow, or a
// clarification ask when before-vs-during is ambiguous.
//
// Uses calendar months in UTC (same contract as resolveDateWindow). Does NOT
// invent half-open IST ranges.

const MONTH_NAMES = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_ALT = Object.keys(MONTH_NAMES).join('|');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDay(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function resolveYearMonth(monthNum, yearHint, now) {
  const y = yearHint != null ? yearHint : now.getUTCFullYear();
  return { y, m: monthNum };
}

/**
 * @param {string} text
 * @param {Date} [now]
 * @returns {{
 *   needsClarification?: boolean,
 *   clarifyingQuestion?: string,
 *   month?: string,
 *   date?: string,
 *   fromDate?: string,
 *   toDate?: string,
 *   relation?: 'during'|'before'|'after'|'on',
 *   label?: string,
 * } | null}
 */
export function phraseToDateWindow(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // Explicit ISO range wins.
  const range = raw.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|–|-|until)\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (range) {
    return {
      fromDate: range[1],
      toDate: range[2],
      relation: 'during',
      label: `${range[1]} to ${range[2]}`,
    };
  }

  const isoDayMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDayMatch) {
    return { date: isoDayMatch[1], relation: 'on', label: isoDayMatch[1] };
  }

  const isoMonth = raw.match(/\b(\d{4}-\d{2})\b/);
  if (isoMonth && !/\d{4}-\d{2}-\d{2}/.test(raw)) {
    const hasBefore = /\b(before|prior to|up to|until)\b/i.test(raw);
    const hasDuring = /\b(during|in|within|throughout|over)\b/i.test(raw);
    if (hasBefore && !hasDuring) {
      const [y, mm] = isoMonth[1].split('-').map(Number);
      const prevM = mm === 1 ? 12 : mm - 1;
      const prevY = mm === 1 ? y - 1 : y;
      const toDate = isoDay(prevY, prevM, lastDayOfMonth(prevY, prevM));
      return {
        fromDate: '1970-01-01',
        toDate,
        relation: 'before',
        label: `before ${isoMonth[1]}`,
      };
    }
    if (hasDuring || !hasBefore) {
      // Bare YYYY-MM treated as during that month (explicit enough).
      return { month: isoMonth[1], relation: 'during', label: isoMonth[1] };
    }
  }

  const named = raw.match(
    new RegExp(
      `\\b(?:(before|prior to|up to|until|during|in|within|throughout|over|after)\\s+)?(${MONTH_ALT})(?:\\s+(\\d{4}))?\\b`,
      'i'
    )
  );
  if (!named) {
    // Relative buckets already handled elsewhere — leave empty for caller.
    if (/\b(this month|last month|this week|last week|today|yesterday)\b/i.test(raw)) {
      const label = raw.match(/\b(this month|last month|this week|last week|today|yesterday)\b/i)[1].toLowerCase();
      if (label === 'this month') {
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth() + 1;
        return { month: `${y}-${pad2(m)}`, relation: 'during', label };
      }
      if (label === 'last month') {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        return {
          month: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`,
          relation: 'during',
          label,
        };
      }
      if (label === 'today' || label === 'yesterday') {
        const d = new Date(now);
        if (label === 'yesterday') d.setUTCDate(d.getUTCDate() - 1);
        const iso = d.toISOString().slice(0, 10);
        return { date: iso, relation: 'on', label };
      }
      // week ranges — clarify rather than invent week bounds
      return {
        needsClarification: true,
        clarifyingQuestion:
          `Did you mean a specific date range for "${label}"? Please give dates as YYYY-MM-DD to YYYY-MM-DD.`,
        label,
      };
    }
    return null;
  }

  const relationWord = (named[1] || '').toLowerCase();
  const monthNum = MONTH_NAMES[named[2].toLowerCase()];
  const yearHint = named[3] ? Number(named[3]) : null;
  const { y, m } = resolveYearMonth(monthNum, yearHint, now);
  const month = `${y}-${pad2(m)}`;

  const isBefore = /^(before|prior to|up to|until)$/.test(relationWord);
  const isDuring = /^(during|in|within|throughout|over)$/.test(relationWord);
  const isAfter = relationWord === 'after';

  if (!relationWord) {
    // Ambiguous bare month — ask before vs during (Epic A success criterion).
    return {
      needsClarification: true,
      clarifyingQuestion:
        `Did you mean people whose date falls **during ${named[2]}${yearHint ? ` ${yearHint}` : ''}** ` +
        `(the calendar month), or **before** that month began?`,
      month,
      label: named[2],
    };
  }

  if (isBefore) {
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const toDate = isoDay(prevY, prevM, lastDayOfMonth(prevY, prevM));
    return {
      fromDate: '1970-01-01',
      toDate,
      relation: 'before',
      label: `before ${month}`,
    };
  }

  if (isAfter) {
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const fromDate = isoDay(nextY, nextM, 1);
    // Open-ended: through "today" in UTC
    const toDate = now.toISOString().slice(0, 10);
    return {
      fromDate,
      toDate,
      relation: 'after',
      label: `after ${month}`,
    };
  }

  if (isDuring) {
    return { month, relation: 'during', label: `during ${month}` };
  }

  return { month, relation: 'during', label: month };
}

/**
 * Convert phraseToDateWindow output into resolveDateWindow() args.
 * @param {ReturnType<typeof phraseToDateWindow>} parsed
 */
export function toResolveDateWindowArgs(parsed) {
  if (!parsed || parsed.needsClarification) return null;
  const out = {};
  if (parsed.date) out.date = parsed.date;
  if (parsed.month) out.month = parsed.month;
  if (parsed.fromDate) out.fromDate = parsed.fromDate;
  if (parsed.toDate) out.toDate = parsed.toDate;
  return out;
}
