import {
  CULTURAL_FIT_VALUES,
  LLM_CLAMP_MIN_WINDOW,
  LLM_CLAMP_PCT,
  LLM_RATIONALE_MAX,
} from '../constants/applicantFit.js';
import { culturalLabelOf, successLabelOf } from './applicantFit.engine.js';

const CULTURAL_FIT_SET = new Set(CULTURAL_FIT_VALUES);

/**
 * Normalize a cultural-fit enum. Unknown values are rejected (null).
 * @param {unknown} value
 * @returns {'fit'|'not_fit'|'unclear'|null}
 */
export function parseCulturalFit(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (key === 'notafit') return 'not_fit';
  if (CULTURAL_FIT_SET.has(key)) return key;
  return null;
}

/**
 * Pull fit rows out of a model JSON object. Drops garbage / out-of-range %.
 * @param {unknown} parsed
 * @returns {Array<{ id: string, successProbability: number, culturalFit: string, rationale: string }>}
 */
export function parseLlmFits(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const rows = Array.isArray(parsed.fits) ? parsed.fits : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    const pct = Number(row.successProbability);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const culturalFit = parseCulturalFit(row.culturalFit);
    if (!culturalFit) continue;
    out.push({
      id,
      successProbability: Math.round(pct),
      culturalFit,
      rationale: String(row.rationale || '').trim().slice(0, LLM_RATIONALE_MAX),
    });
  }
  return out;
}

/**
 * Keep an LLM probability inside heuristic ±pct, with a minimum window.
 * @param {number} llmPct
 * @param {number} heuristicPct
 * @param {number} [pct]
 * @returns {number}
 */
export function clampSuccessProbability(llmPct, heuristicPct, pct = LLM_CLAMP_PCT) {
  const h = Math.min(100, Math.max(0, Math.round(Number(heuristicPct) || 0)));
  let floor = Math.round(h * (1 - pct));
  let ceil = Math.round(h * (1 + pct));
  if (ceil - floor < LLM_CLAMP_MIN_WINDOW) {
    floor = Math.max(0, h - LLM_CLAMP_MIN_WINDOW);
    ceil = Math.min(100, h + LLM_CLAMP_MIN_WINDOW);
  }
  floor = Math.min(100, Math.max(0, floor));
  ceil = Math.min(100, Math.max(0, ceil));
  if (ceil < floor) ceil = floor;
  const n = Math.round(Number(llmPct));
  const bounded = Number.isFinite(n) ? n : h;
  return Math.min(ceil, Math.max(floor, bounded));
}

/**
 * Overlay a parsed LLM row onto the heuristic fit. Garbage/missing → heuristic.
 * @param {object} heuristic
 * @param {{ successProbability: number, culturalFit: string, rationale: string }|null} llmRow
 * @returns {object}
 */
export function mergeLlmIntoHeuristic(heuristic, llmRow) {
  if (!llmRow) {
    return { ...heuristic, source: 'heuristic' };
  }
  const successProbability = clampSuccessProbability(
    llmRow.successProbability,
    heuristic.successProbability
  );
  const culturalFit = parseCulturalFit(llmRow.culturalFit) || 'unclear';
  return {
    successProbability,
    successLabel: successLabelOf(successProbability),
    culturalFit,
    culturalLabel: culturalLabelOf(culturalFit),
    rationale: llmRow.rationale || heuristic.rationale,
    source: 'llm',
  };
}
