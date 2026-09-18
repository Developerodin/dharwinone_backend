import {
  BIAS_EVIDENCE_SOURCES,
  BIAS_FLAG_CATEGORIES,
  BIAS_RISK_LEVELS,
} from '../constants/interviewBias.js';

const MAX_FLAGS = 8;
const MAX_EVIDENCE = 8;
const MAX_REASONS = 6;
const MAX_LABEL = 200;
const MAX_QUOTE = 400;
const MAX_REASON = 300;

/**
 * True when quote is a case-insensitive substring of the provided corpus.
 * @param {string} quote
 * @param {string} corpus
 * @returns {boolean}
 */
export function quoteInCorpus(quote, corpus) {
  const q = String(quote || '').trim().toLowerCase();
  if (q.length < 8) return false;
  return String(corpus || '').toLowerCase().includes(q);
}

/**
 * Coerce LLM JSON into a persistable bias report. Garbage → null (caller marks failed).
 * Drops evidence quotes that are not substrings of transcript or scorecard comment.
 * @param {unknown} parsed
 * @param {{ transcriptText: string, comment: string }} corpus
 * @returns {{ riskLevel: string, flags: object[], evidence: object[], reasons: string[] }|null}
 */
export function coerceBiasLlmResult(parsed, corpus) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const riskLevel = String(parsed.riskLevel || '').trim().toLowerCase();
  if (!BIAS_RISK_LEVELS.includes(riskLevel)) return null;

  const flags = [];
  for (const row of Array.isArray(parsed.flags) ? parsed.flags : []) {
    if (flags.length >= MAX_FLAGS) break;
    const category = String(row?.category || '').trim();
    if (!BIAS_FLAG_CATEGORIES.includes(category)) continue;
    const label = String(row?.label || '').trim().slice(0, MAX_LABEL);
    if (!label) continue;
    flags.push({ category, label });
  }

  const transcriptText = corpus?.transcriptText || '';
  const comment = corpus?.comment || '';
  const evidence = [];
  for (const row of Array.isArray(parsed.evidence) ? parsed.evidence : []) {
    if (evidence.length >= MAX_EVIDENCE) break;
    const source = String(row?.source || '').trim();
    if (!BIAS_EVIDENCE_SOURCES.includes(source)) continue;
    const quote = String(row?.quote || '').trim().slice(0, MAX_QUOTE);
    if (!quote) continue;
    const haystack = source === 'scorecard_comment' ? comment : transcriptText;
    if (!quoteInCorpus(quote, haystack)) continue;
    const utteranceId = row?.utteranceId != null && String(row.utteranceId).trim()
      ? String(row.utteranceId).trim().slice(0, 128)
      : null;
    evidence.push({ quote, utteranceId, source });
  }

  const reasons = [];
  for (const row of Array.isArray(parsed.reasons) ? parsed.reasons : []) {
    if (reasons.length >= MAX_REASONS) break;
    const text = String(row || '').trim().slice(0, MAX_REASON);
    if (text) reasons.push(text);
  }

  if (riskLevel === 'low' && flags.length === 0 && reasons.length === 0) {
    reasons.push('No bias indicators found in the transcript or scorecard.');
  }

  if (evidence.length === 0 && riskLevel !== 'low') {
    return {
      riskLevel: 'low',
      flags: [],
      evidence: [],
      reasons: ['No grounded evidence quotes were found; treating this review as low risk.'],
    };
  }

  return { riskLevel, flags, evidence, reasons };
}
