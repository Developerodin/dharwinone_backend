import {
  LLM_CLAMP_PCT,
  LLM_RATIONALE_MAX,
  MAX_FORECAST_DAYS,
  MIN_FORECAST_DAYS,
} from '../constants/hireForecast.js';
import { clampForecastDays, formatRangeLabel, pointToRange } from './hireForecast.engine.js';

/**
 * Race a promise against a timeout. The loser is ignored; the timer is always cleared.
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Pull forecast rows out of a model JSON object.
 * @param {unknown} parsed
 * @returns {Array<{ id: string, daysLow: number, daysHigh: number, rationale: string }>}
 */
export function parseLlmForecasts(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const rows = Array.isArray(parsed.forecasts) ? parsed.forecasts : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    const daysLow = Number(row.daysLow);
    const daysHigh = Number(row.daysHigh);
    if (!Number.isFinite(daysLow) || !Number.isFinite(daysHigh)) continue;
    out.push({
      id,
      daysLow,
      daysHigh,
      rationale: String(row.rationale || '').trim().slice(0, LLM_RATIONALE_MAX),
    });
  }
  return out;
}

/**
 * Keep an LLM range inside heuristic ±pct and the global day window.
 * @param {{ daysLow: number, daysHigh: number }} llm
 * @param {{ daysLow: number, daysHigh: number, point?: number }} heuristic
 * @param {number} [pct]
 * @returns {{ daysLow: number, daysHigh: number }}
 */
export function clampLlmRange(llm, heuristic, pct = LLM_CLAMP_PCT) {
  const hLow = Number(heuristic.daysLow);
  const hHigh = Number(heuristic.daysHigh);
  const floor = clampForecastDays(Math.round(hLow * (1 - pct)));
  const ceil = clampForecastDays(Math.round(hHigh * (1 + pct)));
  let low = clampForecastDays(llm.daysLow);
  let high = clampForecastDays(llm.daysHigh);
  if (high < low) {
    const swap = low;
    low = high;
    high = swap;
  }
  low = Math.min(ceil, Math.max(floor, low));
  high = Math.min(ceil, Math.max(floor, high));
  if (high < low) high = low;
  if (high - low < 3) {
    const spread = pointToRange(heuristic.point || Math.round((low + high) / 2), 0.25);
    low = Math.min(ceil, Math.max(floor, spread.daysLow));
    high = Math.min(ceil, Math.max(floor, spread.daysHigh));
    if (high < low) high = low;
  }
  low = Math.min(MAX_FORECAST_DAYS, Math.max(MIN_FORECAST_DAYS, low));
  high = Math.min(MAX_FORECAST_DAYS, Math.max(MIN_FORECAST_DAYS, high));
  return { daysLow: low, daysHigh: high };
}

/**
 * Overlay a parsed LLM row onto the heuristic forecast. Garbage/missing → heuristic.
 * @param {object} heuristic
 * @param {{ daysLow: number, daysHigh: number, rationale: string }|null} llmRow
 * @returns {object}
 */
export function mergeLlmIntoHeuristic(heuristic, llmRow) {
  if (heuristic.filled || !llmRow) {
    return heuristic;
  }
  const range = clampLlmRange(llmRow, heuristic);
  const rationale = llmRow.rationale || heuristic.heuristicRationale;
  return {
    ...heuristic,
    daysLow: range.daysLow,
    daysHigh: range.daysHigh,
    label: heuristic.thin ? 'Thin pipeline' : formatRangeLabel(range.daysLow, range.daysHigh),
    heuristicRationale: rationale,
    llmMerged: true,
  };
}
