// Days in the current application status, and whether status history shows a
// screen that never became an interview.
//
// stageEntryDates / lastStatusChangeAt are the funnel's readers. Days in status
// still come only from the last statusHistory entry: both helpers fall back
// (createdAt for Applied, updatedAt when statusChangedAt is absent) and that
// fallback is not a status age. No history → null / 'unknown', never a guess.
//
// ponytail: inStatusOverDays and screenedNeverInterviewed scan up to AGING_SCAN_LIMIT
// rows through searchApplications (the page's own query, already deduped). Past that
// the answer is truncated. The upgrade is an $expr on the last statusHistory element
// inside buildApplicantQuery.

import { stageEntryDates, lastStatusChangeAt } from '../../../../applicationStatusHistory.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dayWindowBounds } from '../employees/common.js';

export const AGING_SCAN_LIMIT = 5000;
const DAY_MS = 86400000;
export const SCREENING_STATUS = 'Screening';
export const INTERVIEW_STATUS = 'Interview';

const istDay = (d) => dateStrInTz(new Date(d), DEFAULT_TIMEZONE);
const dayDiff = (fromDay, toDay) => Math.round(
  (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS
);

function mentions(history, status) {
  return history.some((e) => e && (e.to === status || e.from === status));
}

/**
 * @returns {{
 *   daysInStatus: number|null,
 *   statusSince: string|null,
 *   statusChangedAt: string|null,
 *   stageDateBasis: 'history'|'partial'|'none',
 *   daysToScreening: number|null,
 *   daysScreeningToInterview: number|null,
 *   screening: 'unknown'|'not_screened'|'screened_never_interviewed'|'screened_interviewed',
 * }}
 */
export function applicationAge(app, now = new Date()) {
  const entry = stageEntryDates(app);
  const lastChange = lastStatusChangeAt(app);
  const history = Array.isArray(app?.statusHistory) ? app.statusHistory : [];
  const last = history.length ? history[history.length - 1] : null;
  const at = last?.at ? new Date(last.at) : null;
  const valid = Boolean(at && Number.isFinite(at.getTime()));

  let daysToScreening = null;
  let daysScreeningToInterview = null;
  // Screening has no derived record (funnel dateApplication). Only a full history
  // (basis 'history') can time Applied → Screening and Screening → Interview.
  if (entry.basis === 'history') {
    const applied = entry.stages?.Applied ? new Date(entry.stages.Applied) : null;
    const screening = entry.stages?.Screening ? new Date(entry.stages.Screening) : null;
    const interview = entry.stages?.Interview ? new Date(entry.stages.Interview) : null;
    if (applied && Number.isFinite(applied.getTime()) && screening && Number.isFinite(screening.getTime())) {
      daysToScreening = dayDiff(istDay(applied), istDay(screening));
    }
    if (screening && Number.isFinite(screening.getTime()) && interview && Number.isFinite(interview.getTime())) {
      daysScreeningToInterview = dayDiff(istDay(screening), istDay(interview));
    }
  }

  let screening = 'unknown';
  if (history.length) {
    const screened = mentions(history, SCREENING_STATUS);
    const interviewed = mentions(history, INTERVIEW_STATUS);
    if (!screened) screening = 'not_screened';
    else if (interviewed) screening = 'screened_interviewed';
    else screening = 'screened_never_interviewed';
  }

  const recordedChange = lastChange.basis === 'statusChangedAt' && lastChange.at
    ? new Date(lastChange.at)
    : null;

  return {
    daysInStatus: valid ? dayDiff(istDay(at), istDay(now)) : null,
    statusSince: valid ? at.toISOString() : null,
    // updatedAt is not a status change. Surface statusChangedAt only when the helper
    // says it was actually recorded.
    statusChangedAt: recordedChange && Number.isFinite(recordedChange.getTime())
      ? recordedChange.toISOString()
      : null,
    stageDateBasis: history.length ? (entry.basis === 'history' ? 'history' : 'partial') : 'none',
    daysToScreening,
    daysScreeningToInterview,
    screening,
  };
}

/** First instant (ISO) of the IST day `days` ago. inStatusOverDays matches strictly before this. */
export function statusAgeCutoff(now, days) {
  return dayWindowBounds({ from: addDaysToDateStr(istDay(now), -days) }).from;
}

export function keptForAging(age, filters) {
  if (filters?.inStatusOverDays != null) {
    if (age.daysInStatus == null || !(age.daysInStatus > filters.inStatusOverDays)) return false;
  }
  if (filters?.screenedNeverInterviewed === true && age.screening !== 'screened_never_interviewed') return false;
  return true;
}
