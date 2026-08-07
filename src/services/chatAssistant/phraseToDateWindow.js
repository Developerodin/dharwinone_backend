// Map natural-language date phrases → args for resolveDateWindow, or a
// clarification ask when confidence is low / vague phrases need options.
//
// Uses calendar months in UTC (same contract as resolveDateWindow). Does NOT
// invent half-open IST ranges.
//
// Recency rule: a bare month name (no year) resolves to the most recent
// occurrence of that month relative to `now` (Aug 2026 + "july" → 2026-07;
// Jan 2026 + "december" → 2025-12). ConversationMemory year context can pin
// the year for month-only follow-ups ("only july" after "in 2026").

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

const MONTH_LABEL = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDay(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Most recent calendar year in which `monthNum` has already occurred
 * (or is the current month), relative to `now` (UTC).
 */
export function mostRecentYearForMonth(monthNum, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  if (monthNum <= m) return y;
  return y - 1;
}

function resolveYearMonth(monthNum, yearHint, now, memoryYear = null) {
  if (yearHint != null) return { y: yearHint, m: monthNum };
  if (memoryYear != null) return { y: memoryYear, m: monthNum };
  return { y: mostRecentYearForMonth(monthNum, now), m: monthNum };
}

/**
 * Extract a remembered year from ConversationMemory.lastEntities-shaped object.
 */
export function yearFromMemory(memory) {
  if (!memory || typeof memory !== 'object') return null;
  if (memory.lastYear != null && Number.isFinite(Number(memory.lastYear))) {
    return Number(memory.lastYear);
  }
  for (const key of ['lastFromDate', 'lastToDate', 'lastDate']) {
    const v = memory[key];
    if (typeof v === 'string' && /^\d{4}/.test(v)) return Number(v.slice(0, 4));
  }
  const label = memory.lastDateLabel;
  if (typeof label === 'string') {
    const m = label.match(/\b(20\d{2})\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function lastCompletedQuarter(now) {
  const month0 = now.getUTCMonth(); // 0-11
  const y = now.getUTCFullYear();
  const currentQ = Math.floor(month0 / 3); // 0-3
  let lq = currentQ - 1;
  let ly = y;
  if (lq < 0) {
    lq = 3;
    ly = y - 1;
  }
  const startM = lq * 3 + 1; // 1-12
  const endM = startM + 2;
  return {
    fromDate: isoDay(ly, startM, 1),
    toDate: isoDay(ly, endM, lastDayOfMonth(ly, endM)),
    label: `Q${lq + 1} ${ly}`,
  };
}

/**
 * @param {string} text
 * @param {Date} [now]
 * @param {{ lastFromDate?: string, lastToDate?: string, lastDate?: string, lastDateLabel?: string, lastYear?: number }|null} [memory]
 * @returns {{
 *   needsClarification?: boolean,
 *   clarifyingQuestion?: string,
 *   month?: string,
 *   date?: string,
 *   fromDate?: string,
 *   toDate?: string,
 *   relation?: 'during'|'before'|'after'|'on',
 *   label?: string,
 *   confidence?: number,
 *   monthNum?: number,
 *   yearExplicit?: boolean,
 *   yearFromMemory?: boolean,
 *   monthName?: string,
 * } | null}
 */
export function phraseToDateWindow(text, now = new Date(), memory = null) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  const memoryYear = yearFromMemory(memory);

  // Vague phrases — low confidence → clarify with natural options (v1).
  // Checked before month parse so "new joiners in july" still hits month path
  // only when a concrete month is also present; bare vague terms clarify.
  const hasNamedMonth = new RegExp(`\\b(${MONTH_ALT})\\b`, 'i').test(raw);
  const hasIsoOrYear = /\b(20\d{2}(?:-\d{2}(?:-\d{2})?)?)\b/.test(raw)
    || /\b(this month|last month|last quarter|this week|last week|today|yesterday)\b/i.test(raw);

  if (/\b(financial\s+year|f\.?\s*y\.?)\b/i.test(raw) && !hasNamedMonth && !/\b20\d{2}\b/.test(raw)) {
    return {
      needsClarification: true,
      clarifyingQuestion:
        'Which financial year should I use — for example FY 2025–26 (Apr 2025–Mar 2026) or FY 2024–25?',
      confidence: 0.4,
      label: 'financial year',
    };
  }
  if (/\b(recent|recently)\b/i.test(raw) && !hasNamedMonth && !hasIsoOrYear) {
    return {
      needsClarification: true,
      clarifyingQuestion:
        'How recent should I look — the last 30 days, this calendar month, or a specific month like July 2026?',
      confidence: 0.4,
      label: 'recent',
    };
  }
  if (/\bold\s+employees?\b/i.test(raw) && !hasNamedMonth && !hasIsoOrYear) {
    return {
      needsClarification: true,
      clarifyingQuestion:
        'By “old employees”, did you mean people who resigned before a certain date, or longer-tenured staff still active? Please give a month or year if you can.',
      confidence: 0.35,
      label: 'old employees',
    };
  }
  if (/\bnew\s+joiners?\b/i.test(raw) && !hasNamedMonth && !hasIsoOrYear) {
    return {
      needsClarification: true,
      clarifyingQuestion:
        'For new joiners, which period works — this month, last month, or a specific month like July 2026?',
      confidence: 0.4,
      label: 'new joiners',
    };
  }

  // Explicit ISO range wins.
  const range = raw.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|–|-|until)\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (range) {
    return {
      fromDate: range[1],
      toDate: range[2],
      relation: 'during',
      label: `${range[1]} to ${range[2]}`,
      confidence: 1,
      yearExplicit: true,
    };
  }

  const isoDayMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDayMatch) {
    return {
      date: isoDayMatch[1],
      relation: 'on',
      label: isoDayMatch[1],
      confidence: 1,
      yearExplicit: true,
    };
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
        confidence: 0.95,
        yearExplicit: true,
      };
    }
    if (hasDuring || !hasBefore) {
      const [y, mm] = isoMonth[1].split('-').map(Number);
      return {
        month: isoMonth[1],
        relation: 'during',
        label: isoMonth[1],
        confidence: 1,
        yearExplicit: true,
        monthNum: mm,
        monthName: MONTH_LABEL[mm],
      };
    }
  }

  // Bare calendar year (e.g. "resigned in 2026") → full-year window.
  const bareYear = raw.match(/\b(?:in|during|for|over|throughout)\s+(20\d{2})\b/i)
    || raw.match(/\b(20\d{2})\b(?!\s*-\d{2})/);
  // Only treat as bare year when no month name is present.
  if (bareYear && !hasNamedMonth && !isoMonth) {
    const y = Number(bareYear[1]);
    return {
      fromDate: isoDay(y, 1, 1),
      toDate: isoDay(y, 12, 31),
      relation: 'during',
      label: String(y),
      confidence: 0.95,
      yearExplicit: true,
    };
  }

  // Last quarter → most recent completed calendar quarter (auto).
  if (/\blast\s+quarter\b/i.test(raw)) {
    const q = lastCompletedQuarter(now);
    return {
      fromDate: q.fromDate,
      toDate: q.toDate,
      relation: 'during',
      label: q.label,
      confidence: 0.9,
    };
  }

  const named = raw.match(
    new RegExp(
      `\\b(?:only\\s+)?(?:(before|prior to|up to|until|during|in|within|throughout|over|after)\\s+)?(${MONTH_ALT})(?:\\s+(\\d{4}))?\\b`,
      'i'
    )
  );
  if (!named) {
    if (/\b(this month|last month|this week|last week|today|yesterday)\b/i.test(raw)) {
      const label = raw.match(/\b(this month|last month|this week|last week|today|yesterday)\b/i)[1].toLowerCase();
      if (label === 'this month') {
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth() + 1;
        return {
          month: `${y}-${pad2(m)}`,
          relation: 'during',
          label,
          confidence: 0.95,
          monthNum: m,
          monthName: MONTH_LABEL[m],
        };
      }
      if (label === 'last month') {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const m = d.getUTCMonth() + 1;
        return {
          month: `${d.getUTCFullYear()}-${pad2(m)}`,
          relation: 'during',
          label,
          confidence: 0.95,
          monthNum: m,
          monthName: MONTH_LABEL[m],
        };
      }
      if (label === 'today' || label === 'yesterday') {
        const d = new Date(now);
        if (label === 'yesterday') d.setUTCDate(d.getUTCDate() - 1);
        const iso = d.toISOString().slice(0, 10);
        return { date: iso, relation: 'on', label, confidence: 0.95 };
      }
      return {
        needsClarification: true,
        clarifyingQuestion:
          `Did you mean a specific date range for "${label}"? Please give dates as YYYY-MM-DD to YYYY-MM-DD.`,
        label,
        confidence: 0.5,
      };
    }
    return null;
  }

  const relationWord = (named[1] || '').toLowerCase();
  const monthNum = MONTH_NAMES[named[2].toLowerCase()];
  const yearHint = named[3] ? Number(named[3]) : null;
  const usedMemoryYear = yearHint == null && memoryYear != null;
  const { y, m } = resolveYearMonth(monthNum, yearHint, now, usedMemoryYear ? memoryYear : null);
  const month = `${y}-${pad2(m)}`;
  const monthName = MONTH_LABEL[m];

  const isBefore = /^(before|prior to|up to|until)$/.test(relationWord);
  const isDuring = /^(during|in|within|throughout|over)$/.test(relationWord);
  const isAfter = relationWord === 'after';

  // Bare month (or "only July") → treat as during most-recent / memory year.
  // Confidence ≥ 0.9 so calendar auto-resolves; DB multi-year handled upstream.
  if (!relationWord || isDuring) {
    let confidence = 0.9;
    if (yearHint != null) confidence = 1;
    else if (usedMemoryYear) confidence = 0.95;
    else if (isDuring) confidence = 0.92;
    return {
      month,
      relation: 'during',
      label: isDuring ? `during ${month}` : monthName,
      confidence,
      monthNum: m,
      monthName,
      yearExplicit: yearHint != null,
      yearFromMemory: usedMemoryYear,
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
      confidence: yearHint != null ? 0.95 : 0.9,
      monthNum: m,
      monthName,
      yearExplicit: yearHint != null,
      yearFromMemory: usedMemoryYear,
    };
  }

  if (isAfter) {
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const fromDate = isoDay(nextY, nextM, 1);
    const toDate = now.toISOString().slice(0, 10);
    return {
      fromDate,
      toDate,
      relation: 'after',
      label: `after ${month}`,
      confidence: yearHint != null ? 0.95 : 0.9,
      monthNum: m,
      monthName,
      yearExplicit: yearHint != null,
      yearFromMemory: usedMemoryYear,
    };
  }

  return {
    month,
    relation: 'during',
    label: month,
    confidence: 0.9,
    monthNum: m,
    monthName,
  };
}

/**
 * Convert phraseToDateWindow / resolveTemporalWindow output into resolveDateWindow() args.
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

export { MONTH_LABEL, pad2, isoDay, lastDayOfMonth };
