import { ENTITY_JOB } from '../../../../schemas/queryOperations.js';
import { parseJobFilters, looksLikeJobRankingQuery } from './jobRank.js';

const LIST_INTENT_RE = /\b(list|show|display|give|present|tell|enumerate)\s+(me\s+)?(all|every|each|complete|full|the)\b|\blist\s+(jobs?|openings?|positions?)\b|\bshow\s+(jobs?|openings?|positions?)\b/i;

function detectListIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return LIST_INTENT_RE.test(msg);
}

/** Job-noun set for topic-keyword extraction below (adds "roles" to the entity's usual set). */
const JOB_TOPIC_NOUN_RE = /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?|roles?)\b/i;

/**
 * A recognized count/list command phrase must lead the topic zone, or the leftover words
 * aren't a topic at all — e.g. a salary-ranking question like "what's the highest paying
 * job" has no topic to extract, and must not have "what's the highest paying" mistaken for one.
 */
const JOB_TOPIC_LEADIN_RE = /^\s*(?:how many|count|number of|total|list(?:\s+all)?|show(?:\s+me)?(?:\s+all)?|any)\b\s*/i;

/** Status/type/origin modifier words parseJobFilters already extracts — not part of the topic. */
const JOB_TOPIC_MODIFIER_WORDS = new Set([
  'active', 'open', 'live', 'current', 'currently', 'closed', 'filled', 'draft', 'archived',
  'remote', 'internal', 'external', 'intern', 'internship',
  'full-time', 'fulltime', 'part-time', 'parttime', 'contract', 'temporary', 'freelance',
]);

/** Filler words that carry no topic meaning. */
const JOB_TOPIC_FILLER_WORDS = new Set(['the', 'all', 'our', 'any', 'new', 'total', 'of', 'do', 'we', 'have']);

/**
 * Pull the topic word(s) between a count/list phrase and the job noun — "how many **AI**
 * jobs" — into a search term. Without this, a topic like "AI" that isn't a recognized
 * status/type/company/skill filter was silently dropped, so "how many AI jobs" counted
 * every job instead of just AI jobs.
 * @param {string} message
 * @returns {string|null}
 */
export function extractJobTopicKeyword(message) {
  const raw = String(message || '');
  const nounMatch = raw.match(JOB_TOPIC_NOUN_RE);
  if (!nounMatch) return null;

  const before = raw.slice(0, nounMatch.index);
  const leadinMatch = before.match(JOB_TOPIC_LEADIN_RE);
  if (!leadinMatch) return null;

  const words = before.slice(leadinMatch[0].length).split(/\s+/).filter(Boolean);
  const topicWords = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[?.!,]+$/, '');
    return lower && !JOB_TOPIC_MODIFIER_WORDS.has(lower) && !JOB_TOPIC_FILLER_WORDS.has(lower);
  });

  return topicWords.join(' ').trim() || null;
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

  // A fresh question must never seed from a prior turn's filters — only the follow-up
  // path above (an explicit "and ...", "what about ...", etc.) inherits ctx. Passing ctx
  // through here let a stray "active" from an earlier question leak into an unrelated
  // new one (e.g. asking "how many jobs" right after "how many active jobs").
  const filters = parseJobFilters(message, null);
  const topic = extractJobTopicKeyword(message);
  if (topic) filters.search = topic;
  const listIntent = detectListIntent(message);

  return {
    entity: ENTITY_JOB,
    operation: 'FILTER',
    intent: listIntent ? 'list' : 'count',
    filters,
    limit: listIntent ? 50 : 0,
  };
}
