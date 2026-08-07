// Temporal resolver — orchestrates phraseToDateWindow + optional DB year probe
// + ConversationMemory year context for employee resign/join (and reuse elsewhere).
//
// Rules (Epic A temporal upgrade):
// 1. Month with no year → most recent occurrence relative to now.
// 2. DB multi-year for resign/join month → natural clarification with counts.
// 3. Exactly one data year → that year; zero → calendar most-recent.
// 5. Memory year + month-only follow-up → pin year, no re-ask.
// 7. Confidence: ≥90% + no multi-year conflict → auto; multi-year → ask;
//    <70% ambiguous → ask.

import {
  phraseToDateWindow,
  toResolveDateWindowArgs,
  mostRecentYearForMonth,
  yearFromMemory,
  MONTH_LABEL,
  pad2,
} from './phraseToDateWindow.js';

export { mostRecentYearForMonth, yearFromMemory, toResolveDateWindowArgs };

/**
 * @param {{
 *   monthName: string,
 *   eventLabel?: string,
 *   years: Array<{ year: number, count: number }>,
 * }} opts
 */
export function buildMultiYearClarification({ monthName, eventLabel = 'records', years }) {
  const noun = eventLabel === 'resignation'
    ? 'resignation records'
    : eventLabel === 'joining' || eventLabel === 'join'
      ? 'joining records'
      : `${eventLabel} records`;
  const sorted = [...years].sort((a, b) => b.year - a.year);
  const options = sorted
    .map((y) => `${monthName} ${y.year} (${y.count})`)
    .join(' or ');
  return (
    `I found ${noun} in multiple ${monthName}s. ` +
    `Did you mean ${options}?`
  );
}

/**
 * Aggregate distinct years that have data for a given calendar month on
 * resignDate / joiningDate. Respects ownerIds visibility; does not count
 * disabled owners (caller already filtered via employeeOwnerQuery).
 *
 * @param {{
 *   Employee: { aggregate: Function },
 *   ownerIds: any[],
 *   dateField: 'resignDate'|'joiningDate',
 *   monthNum: number,
 * }} opts
 * @returns {Promise<Array<{ year: number, count: number }>>}
 */
export async function probeEmployeeYearsByMonth({
  Employee,
  ownerIds,
  dateField,
  monthNum,
}) {
  if (!Employee || !dateField || !monthNum) return [];
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) return [];

  const rows = await Employee.aggregate([
    {
      $match: {
        owner: { $in: ownerIds },
        [dateField]: { $ne: null, $exists: true },
      },
    },
    {
      $project: {
        y: { $year: `$${dateField}` },
        m: { $month: `$${dateField}` },
      },
    },
    { $match: { m: monthNum } },
    { $group: { _id: '$y', count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ]);

  return (rows || []).map((r) => ({
    year: Number(r._id),
    count: Number(r.count) || 0,
  }));
}

/**
 * Resolve a natural-language date phrase into resolveDateWindow args,
 * optionally probing the DB for multi-year month conflicts.
 *
 * @param {{
 *   text: string,
 *   now?: Date,
 *   memory?: object|null,
 *   dateField?: 'resignDate'|'joiningDate'|null,
 *   eventLabel?: string,
 *   probeYears?: ((monthNum: number) => Promise<Array<{year:number,count:number}>>)|null,
 * }} opts
 */
export async function resolveTemporalWindow({
  text,
  now = new Date(),
  memory = null,
  dateField = null,
  eventLabel = 'records',
  probeYears = null,
} = {}) {
  const parsed = phraseToDateWindow(text, now, memory);
  if (!parsed) return null;

  if (parsed.needsClarification) {
    return parsed;
  }

  const confidence = parsed.confidence ?? 0.5;

  // Low confidence ambiguous → ask (vague phrases already flagged above).
  if (confidence < 0.7) {
    return {
      ...parsed,
      needsClarification: true,
      clarifyingQuestion: parsed.clarifyingQuestion
        || 'Could you give a clearer period — a month and year, or YYYY-MM-DD to YYYY-MM-DD?',
    };
  }

  // DB probe only for month windows on resign/join-style fields, when year
  // was not explicitly stated and not pinned by conversation memory.
  const canProbe = !!(
    probeYears
    && dateField
    && parsed.month
    && parsed.monthNum
    && !parsed.yearExplicit
    && !parsed.yearFromMemory
  );

  if (canProbe) {
    let years = [];
    try {
      years = await probeYears(parsed.monthNum);
    } catch {
      years = [];
    }
    const withData = (years || []).filter((y) => y && y.count > 0);

    if (withData.length > 1) {
      const monthName = parsed.monthName || MONTH_LABEL[parsed.monthNum] || 'that month';
      const sorted = [...withData].sort((a, b) => b.year - a.year);
      return {
        needsClarification: true,
        clarifyingQuestion: buildMultiYearClarification({
          monthName,
          eventLabel,
          years: sorted,
        }),
        options: sorted,
        monthNum: parsed.monthNum,
        monthName,
        confidence,
        label: parsed.label,
      };
    }

    if (withData.length === 1) {
      const y = withData[0].year;
      const month = `${y}-${pad2(parsed.monthNum)}`;
      return {
        month,
        relation: 'during',
        label: `during ${month}`,
        confidence: Math.max(confidence, 0.95),
        monthNum: parsed.monthNum,
        monthName: parsed.monthName,
        yearFromData: true,
      };
    }
    // zero years → fall through to calendar most-recent (parsed.month)
  }

  // High confidence (≥0.9) or explicit window → auto.
  if (confidence >= 0.9 || parsed.yearExplicit || parsed.yearFromMemory) {
    return parsed;
  }

  // Mid confidence without multi-year conflict — still auto if we have a month.
  if (parsed.month || parsed.fromDate || parsed.date) {
    return parsed;
  }

  return {
    needsClarification: true,
    clarifyingQuestion:
      'Could you give a clearer period — a month and year, or YYYY-MM-DD to YYYY-MM-DD?',
    confidence,
  };
}
