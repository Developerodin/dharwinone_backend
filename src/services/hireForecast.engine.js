import {
  BASE_DAYS_BY_SENIORITY,
  DEFAULT_BASE_DAYS,
  MAX_FORECAST_DAYS,
  MIN_FORECAST_DAYS,
} from '../constants/hireForecast.js';

/**
 * Clamp a day count into the forecast window.
 * @param {number} days
 * @returns {number}
 */
export function clampForecastDays(days) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n)) return MIN_FORECAST_DAYS;
  return Math.min(MAX_FORECAST_DAYS, Math.max(MIN_FORECAST_DAYS, n));
}

/**
 * Format a closed days range for the jobs table.
 * @param {number} daysLow
 * @param {number} daysHigh
 * @returns {string}
 */
export function formatRangeLabel(daysLow, daysHigh) {
  if (daysLow === daysHigh) return `${daysLow} day${daysLow === 1 ? '' : 's'}`;
  return `${daysLow}–${daysHigh} days`;
}

/**
 * Spread a point estimate into a range. Thin pipelines use a wider band.
 * @param {number} point
 * @param {number} pct
 * @returns {{ daysLow: number, daysHigh: number }}
 */
export function pointToRange(point, pct) {
  const p = clampForecastDays(point);
  let low = clampForecastDays(Math.round(p * (1 - pct)));
  let high = clampForecastDays(Math.round(p * (1 + pct)));
  if (high < low) high = low;
  if (high - low < 3) {
    high = Math.min(MAX_FORECAST_DAYS, Math.max(low + 3, high));
    if (high - low < 3) low = Math.max(MIN_FORECAST_DAYS, high - 3);
  }
  return { daysLow: low, daysHigh: high };
}

/**
 * @param {object} signals
 * @returns {boolean}
 */
export function isFilledSignals(signals) {
  const vacancies = Number(signals?.vacancies);
  const cap = Number.isFinite(vacancies) && vacancies > 0 ? vacancies : 1;
  const hired = Math.max(0, Number(signals?.hired) || 0);
  const remaining = Math.max(0, cap - hired);
  if (remaining === 0) return true;
  const status = signals?.status;
  return (status === 'Closed' || status === 'Archived') && hired >= cap;
}

/**
 * Remaining openings after hired count.
 * @param {object} signals
 * @returns {number}
 */
export function remainingVacanciesOf(signals) {
  const vacancies = Number(signals?.vacancies);
  const cap = Number.isFinite(vacancies) && vacancies > 0 ? vacancies : 1;
  const hired = Math.max(0, Number(signals?.hired) || 0);
  return Math.max(0, cap - hired);
}

/**
 * Volume / quality / pipeline / velocity modifiers on the seniority base.
 * @param {object} signals
 * @param {number} remaining
 * @returns {number}
 */
function shiftFromSignals(signals, remaining) {
  const applicants = Math.max(0, Number(signals.applicants) || 0);
  const perVacancy = remaining > 0 ? applicants / remaining : applicants;
  let shift = 0;
  if (applicants === 0) shift += 21;
  else if (perVacancy < 3) shift += 10;
  else if (perVacancy > 8) shift -= 7;

  const avgLiveFit = signals.avgLiveFit;
  if (typeof avgLiveFit === 'number' && Number.isFinite(avgLiveFit)) {
    if (avgLiveFit >= 70) shift -= 7;
    else if (avgLiveFit < 40) shift += 10;
  }

  const advancedCount =
    (Number(signals.interview) || 0) + (Number(signals.shortlisted) || 0) + (Number(signals.offered) || 0);
  const strongFitCount = Math.max(0, Number(signals.strongFitCount) || 0);
  if (strongFitCount >= remaining && advancedCount >= 1) shift -= 10;

  const offered = Math.max(0, Number(signals.offered) || 0);
  if (offered >= remaining) shift -= 14;
  else if (advancedCount > 0) shift -= 7;
  else {
    const live =
      (Number(signals.applied) || 0) + (Number(signals.screening) || 0) + advancedCount;
    if (live > 0) shift += 7;
  }

  const appsLast7Days = Math.max(0, Number(signals.appsLast7Days) || 0);
  const daysOpen = Math.max(0, Number(signals.daysOpen) || 0);
  if (appsLast7Days === 0 && daysOpen >= 14) shift += 7;
  else if (appsLast7Days >= Math.max(5, remaining * 2)) shift -= 5;

  if (remaining > 1) shift += 4 * (remaining - 1);
  return shift;
}

/**
 * Recruiter-facing one-liner from the dominant signal.
 * @param {object} signals
 * @param {number} remaining
 * @param {boolean} thin
 * @returns {string}
 */
function heuristicRationale(signals, remaining, thin) {
  if (thin) {
    return `No applicants yet for ${remaining} opening${remaining === 1 ? '' : 's'}.`;
  }
  const offered = Number(signals.offered) || 0;
  if (offered >= remaining) return 'Offers already cover remaining openings.';
  const strongFitCount = Number(signals.strongFitCount) || 0;
  if (strongFitCount >= remaining) {
    return `${strongFitCount} strong skill-fit candidate${strongFitCount === 1 ? '' : 's'} in the pipeline.`;
  }
  const avgLiveFit = signals.avgLiveFit;
  if (typeof avgLiveFit === 'number' && avgLiveFit < 40) {
    return 'Inbound skill match is weak relative to this job.';
  }
  const applicants = Number(signals.applicants) || 0;
  if (applicants > 0 && remaining > 0 && applicants / remaining < 3) {
    return `Thin candidate volume for ${remaining} opening${remaining === 1 ? '' : 's'}.`;
  }
  return `${applicants} applicant${applicants === 1 ? '' : 's'} against ${remaining} opening${remaining === 1 ? '' : 's'}.`;
}

/**
 * Confidence from volume + pipeline quality.
 * @param {object} signals
 * @param {boolean} thin
 * @returns {'low'|'medium'|'high'}
 */
function confidenceFromSignals(signals, thin) {
  if (thin) return 'low';
  const applicants = Number(signals.applicants) || 0;
  const avgLiveFit = signals.avgLiveFit;
  const advancedCount =
    (Number(signals.interview) || 0) + (Number(signals.shortlisted) || 0) + (Number(signals.offered) || 0);
  const strongQuality = (typeof avgLiveFit === 'number' && avgLiveFit >= 60) || advancedCount > 0;
  if (applicants >= 5 && strongQuality) return 'high';
  if (applicants >= 3) return 'medium';
  return 'low';
}

/**
 * Deterministic remaining-days forecast from pipeline, skill fit, and vacancies.
 * @param {object} signals
 * @returns {{ daysLow: number, daysHigh: number, confidence: string, label: string, heuristicRationale: string, remainingVacancies: number, thin: boolean, filled: boolean, point: number }}
 */
export function forecastFromSignals(signals = {}) {
  const remaining = remainingVacanciesOf(signals);
  if (isFilledSignals(signals)) {
    return {
      daysLow: 0,
      daysHigh: 0,
      confidence: 'high',
      label: 'Filled',
      heuristicRationale: 'All openings are filled.',
      remainingVacancies: 0,
      thin: false,
      filled: true,
      point: 0,
    };
  }

  const applicants = Math.max(0, Number(signals.applicants) || 0);
  const thin = applicants === 0;
  const base = BASE_DAYS_BY_SENIORITY[signals.experienceLevel] || DEFAULT_BASE_DAYS;
  const point = clampForecastDays(base + shiftFromSignals(signals, remaining));
  const range = pointToRange(point, thin ? 0.4 : 0.25);
  return {
    ...range,
    confidence: confidenceFromSignals(signals, thin),
    label: thin ? 'Thin pipeline' : formatRangeLabel(range.daysLow, range.daysHigh),
    heuristicRationale: heuristicRationale(signals, remaining, thin),
    remainingVacancies: remaining,
    thin,
    filled: false,
    point,
  };
}

/**
 * Payload attached onto each job in the staff list.
 * @param {object} forecast
 * @param {{ applicants?: number, strongFitCount?: number, source?: string, rationale?: string }} extra
 * @returns {object}
 */
export function toHireForecastDto(forecast, extra = {}) {
  return {
    daysLow: forecast.daysLow,
    daysHigh: forecast.daysHigh,
    confidence: forecast.confidence,
    label: forecast.label,
    rationale: extra.rationale || forecast.heuristicRationale,
    source: extra.source || 'heuristic',
    applicants: Math.max(0, Number(extra.applicants) || 0),
    strongFits: Math.max(0, Number(extra.strongFitCount) || 0),
    remainingVacancies: forecast.remainingVacancies,
  };
}
