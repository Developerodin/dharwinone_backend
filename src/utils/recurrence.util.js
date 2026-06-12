import rrulePkg from 'rrule';
import { normalizeTimezone, wallClockToUtc, wallClockPartsInZone } from './timezone.js';

// rrule ships as CommonJS; under ESM the named export isn't reliably exposed.
const { RRule } = rrulePkg;

/**
 * Recurrence helpers for meeting series. rrule operates in a "naive local" space:
 * we build dtstart from the series' wall-clock parts (treated as UTC), generate,
 * then convert each naive occurrence back to a real UTC instant in the series
 * timezone via wallClockToUtc. This keeps occurrences anchored to the intended
 * local time across DST changes.
 */

const FREQ_MAP = { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY };
// JS getDay convention: 0=Sun .. 6=Sat → rrule weekday objects.
const RRULE_WEEKDAYS = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];

const naiveFromInstant = (instant, tz) => {
  const p = wallClockPartsInZone(instant, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
};

/**
 * Build an RRule from a MeetingSeries doc (operating in naive-local space).
 * @param {Object} series
 * @returns {RRule}
 */
export const buildRule = (series) => {
  const tz = normalizeTimezone(series.timezone);
  const rec = series.recurrence || {};
  let freq = FREQ_MAP[rec.frequency];
  if (rec.frequency === 'custom') {
    // 'custom' = weekly-with-days when days are picked, else plain interval (daily).
    freq = rec.daysOfWeek && rec.daysOfWeek.length ? RRule.WEEKLY : RRule.DAILY;
  }
  if (freq === undefined) freq = RRule.WEEKLY;

  const opts = {
    freq,
    interval: Math.max(1, Number(rec.interval) || 1),
    dtstart: naiveFromInstant(series.startAt, tz),
  };
  if (freq === RRule.WEEKLY && rec.daysOfWeek && rec.daysOfWeek.length) {
    opts.byweekday = rec.daysOfWeek.map((d) => RRULE_WEEKDAYS[d]).filter(Boolean);
  }
  if (freq === RRule.MONTHLY && rec.dayOfMonth) {
    opts.bymonthday = rec.dayOfMonth;
  }

  const end = series.end || {};
  if (end.mode === 'afterCount' && end.count) {
    opts.count = end.count;
  } else if (end.mode === 'onDate' && end.untilDate) {
    const ep = wallClockPartsInZone(end.untilDate, tz);
    // Inclusive of the whole end day.
    opts.until = new Date(Date.UTC(ep.year, ep.month - 1, ep.day, 23, 59, 59));
  }
  return new RRule(opts);
};

/**
 * Recurring series must not backfill before creation. If the requested start is
 * earlier than `createdAt`, re-anchor to the creation day while KEEPING the
 * requested wall-clock time, so the series stays at the time the user picked
 * (daily 9 AM stays 9 AM). If that time already passed on the creation day, the
 * materialization floor simply skips that first occurrence and the series begins
 * on the next matching day — never in the past.
 * @param {Date|string|number} requestedStart
 * @param {Date|string|number} createdAt
 * @param {string} tz
 * @returns {Date}
 */
export const clampSeriesStartAt = (requestedStart, createdAt, tz) => {
  const req = requestedStart instanceof Date ? requestedStart : new Date(requestedStart);
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(req.getTime()) || Number.isNaN(created.getTime())) return req;
  if (req.getTime() >= created.getTime()) return req;

  const zone = normalizeTimezone(tz);
  const startParts = wallClockPartsInZone(req, zone);
  const createParts = wallClockPartsInZone(created, zone);
  return wallClockToUtc(
    {
      year: createParts.year,
      month: createParts.month,
      day: createParts.day,
      hour: startParts.hour,
      minute: startParts.minute,
      second: 0,
    },
    zone
  );
};

/**
 * Earliest instant we may materialize for a series.
 * Never backfill before series start, creation time, or the current moment.
 * Truncated to the start of the minute: occurrences are generated with
 * second=0, so without truncation the day-of-creation occurrence would sit a
 * few seconds "before" the floor and be silently dropped (series would appear
 * to start tomorrow instead of today).
 */
export const seriesMaterializationFloor = (series, now = new Date()) => {
  const start = new Date(series.startAt).getTime();
  const created = series.createdAt ? new Date(series.createdAt).getTime() : now.getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const floor = Math.max(start, created, current);
  return new Date(Math.floor(floor / 60000) * 60000);
};

/**
 * Generate occurrences from the series start up to (and including) horizonDate.
 * occurrenceIndex is the global 0-based position from the first occurrence and is
 * stable across runs as long as the rule + startAt are unchanged.
 * @param {Object} series
 * @param {Date} horizonDate - real UTC instant; do not materialize past this
 * @returns {Array<{ index: number, at: Date }>}
 */
export const generateOccurrences = (series, horizonDate) => {
  const tz = normalizeTimezone(series.timezone);
  const rule = buildRule(series);
  const horizonNaive = naiveFromInstant(horizonDate, tz);
  const naiveList = rule.between(rule.options.dtstart, horizonNaive, true);
  return naiveList.map((d, i) => ({
    index: i,
    at: wallClockToUtc(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: 0,
      },
      tz
    ),
  }));
};

/**
 * The RRULE property value (without the "RRULE:" prefix) for an ICS VEVENT.
 * @param {Object} series
 * @returns {string} e.g. "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=4"
 */
export const buildRRuleString = (series) => {
  const rule = buildRule(series);
  const line = rule
    .toString()
    .split('\n')
    .find((l) => l.startsWith('RRULE:'));
  return line ? line.replace(/^RRULE:/, '') : '';
};

/**
 * Short human label for list badges.
 * @param {Object} recurrence
 * @returns {string}
 */
export const recurrenceLabel = (recurrence) => {
  if (!recurrence || !recurrence.frequency) return '';
  const map = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom' };
  return map[recurrence.frequency] || 'Custom';
};
