import { ENTITY_JOB } from '../../../../schemas/queryOperations.js';
import { parseJobFilters, looksLikeJobRankingQuery } from './jobRank.js';

const LIST_INTENT_RE = /\b(list|show|display|give|present|tell|enumerate)\s+(me\s+)?(all|every|each|complete|full|the)\b|\blist\s+(jobs?|openings?|positions?)\b|\bshow\s+(jobs?|openings?|positions?)\b/i;

function detectListIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return LIST_INTENT_RE.test(msg);
}

const JOB_SUBJECT_RE =
  /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?)\b/i;

const COUNT_INTENT_RE =
  /\b(how many|count|number of|total)\b/i;

const FOLLOWUP_FILTER_RE =
  /^\s*(?:and|what about|only|just|show(?:\s+me)?|filter(?:\s+to)?|limit(?:\s+to)?|also|with|over|above|pay(?:ing)?|salary|require|requiring)\b/i;

const FOLLOWUP_SALARY_RE =
  /\b(?:over|above|more than|at least|pay(?:ing)?|salary)\b.*\d/i;

const FOLLOWUP_SKILL_RE =
  /\b(?:require|requiring|needs?|with)\s+[A-Za-z#+.]/i;

const FOLLOWUP_SHORT_RE =
  /^\s*(external|internal)\s*(?:ones?|jobs?)?\s*[?.!]*\s*$/i;

/**
 * Merge origin follow-ups ("and external") into prior job filter context.
 *
 * @param {string} message
 * @param {object|null} ctx
 * @returns {object|null}
 */
export function parseJobFollowUp(message, ctx = null) {
  if (!ctx?.filters || !Object.keys(ctx.filters).length) return null;
  const t = String(message || '').trim();
  const lower = t.toLowerCase();

  let originMatch = t.match(/^\s*(?:and|what about|only|just|show(?:\s+me)?|filter(?:\s+to)?|limit(?:\s+to)?)\s+(external|internal)\b/i);
  if (!originMatch) originMatch = t.match(FOLLOWUP_SHORT_RE);

  const isFilterFollowUp =
    !!originMatch ||
    FOLLOWUP_FILTER_RE.test(t) ||
    FOLLOWUP_SALARY_RE.test(t) ||
    FOLLOWUP_SKILL_RE.test(t) ||
    /\bremote\b/i.test(lower) ||
    /\bfull[\s-]?time\b/i.test(lower) ||
    /\bintern(?:ship)?\b/i.test(lower);

  if (!isFilterFollowUp) return null;

  const mergedFilters = parseJobFilters(message, ctx);
  if (originMatch) mergedFilters.jobOrigin = originMatch[1].toLowerCase();

  const listIntent = detectListIntent(t) || ctx.intent === 'list';
  const countIntent = COUNT_INTENT_RE.test(t) || ctx.intent === 'count' || !listIntent;

  return {
    entity: ENTITY_JOB,
    operation: 'FILTER',
    intent: listIntent && !countIntent ? 'list' : 'count',
    filters: mergedFilters,
    limit: listIntent ? (ctx.limit ?? 50) : 0,
  };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeJobFilterQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!JOB_SUBJECT_RE.test(t)) return false;
  if (looksLikeJobRankingQuery(t)) return false;
  if (COUNT_INTENT_RE.test(t)) return true;
  if (detectListIntent(t)) return true;
  if (/\b(external|internal)\b/i.test(t)) return true;
  if (/\b(?:require|requiring|needs?|with)\s+[A-Za-z#+.]/i.test(t)) return true;
  if (/\b(?:over|above|more than|at least)\s*\$?\s*\d/i.test(t)) return true;
  if (/\b\d+\s*(?:-|to)\s*\d+\s*years?\b/i.test(t)) return true;
  return false;
}

/**
 * @param {{ userMessage: string, jobQueryContext?: object|null }} input
 * @returns {object|null}
 */
export function planJobFilterQuery({ userMessage, jobQueryContext = null }) {
  const message = String(userMessage || '').trim();
  if (!message) return null;

  const ctx = jobQueryContext;
  const followUp = parseJobFollowUp(message, ctx);
  if (followUp) return followUp;

  if (!looksLikeJobFilterQuery(message)) return null;

  const filters = parseJobFilters(message, ctx);
  const listIntent = detectListIntent(message);

  return {
    entity: ENTITY_JOB,
    operation: 'FILTER',
    intent: listIntent ? 'list' : 'count',
    filters,
    limit: listIntent ? 50 : 0,
  };
}
