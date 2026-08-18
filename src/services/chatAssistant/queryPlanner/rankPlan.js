// Entity-agnostic rank primitives. Deliberately imports nothing from entities/ —
// jobRank.js imports this file, so a back-import would be a cycle.
import { DEFAULT_JOB_RANK_LIMIT, MAX_JOB_RANK_LIMIT } from '../../../schemas/queryOperations.js';

export const RANK_CUE_RE =
  /\b(most|highest|top|maximum|max|best[\s-]?pay(?:ing)?|lowest|least|minimum|min|fewest|rank|ranked|ranking|second|third|fourth|fifth)\b/i;

export const TOP_N_RE = /\btop\s+(\d+)\b/i;

export const ORDINAL_OFFSET = Object.freeze({
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
});

export const ORDINAL_FOLLOWUP_RE =
  /\b(second|third|fourth|fifth)\s+(highest|lowest|top|paying)\b/i;

export const TOP_FOLLOWUP_RE = /^\s*top\s+(\d+)\s*\.?\s*$/i;

/**
 * @param {number|string} raw
 * @param {{ defaultLimit?: number, maxLimit?: number }} [opts]
 * @returns {number}
 */
export function clampRankLimit(raw, opts = {}) {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_JOB_RANK_LIMIT;
  const maxLimit = opts.maxLimit ?? MAX_JOB_RANK_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultLimit;
  return Math.min(Math.max(Math.trunc(n), 1), maxLimit);
}

/**
 * @param {string} message
 * @returns {'asc'|'desc'}
 */
export function resolveRankDirection(message) {
  const t = String(message || '').toLowerCase();
  if (/\b(lowest|least|minimum|min|fewest)\b/.test(t)) return 'asc';
  if (/\b(highest|most|maximum|max|top|best[\s-]?pay(?:ing)?)\b/.test(t)) return 'desc';
  return 'desc';
}

/**
 * @param {string} message
 * @param {{ singleItemRe?: RegExp }} [opts]
 * @returns {number}
 */
export function resolveRankLimit(message, opts = {}) {
  const text = String(message || '');
  const topMatch = text.match(TOP_N_RE);
  if (topMatch) return clampRankLimit(topMatch[1], opts);
  const singleItemRe =
    opts.singleItemRe ??
    /\b(which|what)\b[\s\S]*\b(job|employee|person|task)\b/i;
  if (singleItemRe.test(text)) return 1;
  if (/\b(highest|lowest|least|most|best|top)\b[\s\S]{0,40}\b(job|employee|person|task)\b/i.test(text)) {
    return 1;
  }
  if (ORDINAL_FOLLOWUP_RE.test(text)) return 1;
  return clampRankLimit(undefined, opts);
}

/**
 * @param {string} message
 * @returns {number}
 */
export function resolveRankOffset(message) {
  const m = String(message || '').match(/\b(second|third|fourth|fifth)\b/i);
  if (!m) return 0;
  return ORDINAL_OFFSET[m[1].toLowerCase()] ?? 0;
}

/**
 * @param {string} message
 * @param {number} limit
 * @param {number} offset
 * @param {'asc'|'desc'} direction
 * @returns {'MAX'|'MIN'|'TOP_N'|'RANK'}
 */
export function resolveRankOperation(message, limit, offset, direction) {
  if (offset > 0) return direction === 'asc' ? 'MIN' : 'RANK';
  if (limit === 1) return direction === 'asc' ? 'MIN' : 'MAX';
  return 'TOP_N';
}

/**
 * Parse ordinal / top-N follow-ups when ctx already carries a metric.
 *
 * @param {string} message
 * @param {{ metric?: string, direction?: string, filters?: object, operation?: string }} ctx
 * @returns {{ operation: string, limit: number, offset: number, direction: 'asc'|'desc' }|null}
 */
export function parseRankFollowUp(message, ctx) {
  if (!ctx?.metric) return null;

  if (ORDINAL_FOLLOWUP_RE.test(message)) {
    const direction = /\blowest\b/.test(message) ? 'asc' : (ctx.direction ?? 'desc');
    return {
      operation: 'RANK',
      limit: 1,
      offset: resolveRankOffset(message),
      direction,
    };
  }

  const topFollowUp = String(message || '').match(TOP_FOLLOWUP_RE);
  if (topFollowUp) {
    return {
      operation: 'TOP_N',
      limit: clampRankLimit(topFollowUp[1]),
      offset: 0,
      direction: ctx.direction ?? 'desc',
    };
  }

  return null;
}
