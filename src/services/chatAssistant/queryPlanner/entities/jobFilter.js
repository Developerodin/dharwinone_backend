import { ENTITY_JOB } from '../../../../schemas/queryOperations.js';
import { parseJobFilters, looksLikeJobRankingQuery } from './jobRank.js';

const LIST_INTENT_RE =
  /\b(list|show|display|give|present|tell|enumerate)\s+(me\s+)?(all|every|each|complete|full|the)\b|\b(?:list|show(?:\s+me)?)\s+(?:all\s+|the\s+)?(?:[A-Za-z][\w-]*\s+){0,4}(?:jobs?|openings?|positions?|roles?|vacanc(?:y|ies))\b/i;

function detectListIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return LIST_INTENT_RE.test(msg);
}

/**
 * "any data science roles" — a bare "any ... <job noun>" question, same bounded shape as
 * the list/show pattern above but without an explicit list/show verb.
 */
const ANY_JOB_QUERY_RE =
  /\bany\s+(?:[A-Za-z][\w-]*\s+){0,4}(?:jobs?|openings?|positions?|roles?|vacanc(?:y|ies))\b/i;

/** Job-noun set for topic-keyword extraction below (adds "roles" to the entity's usual set). */
const JOB_TOPIC_NOUN_RE = /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?|roles?)\b/i;

/**
 * A recognized count/list command phrase must lead the topic zone, or the leftover words
 * aren't a topic at all — e.g. a salary-ranking question like "what's the highest paying
 * job" has no topic to extract, and must not have "what's the highest paying" mistaken for
 * one. Includes the follow-up lead-ins too (and/what about/only/just/filter to/limit to) so
 * a follow-up like "what about react jobs?" can extract "react" the same way a fresh
 * question does.
 */
const JOB_TOPIC_LEADIN_RE =
  /^\s*(?:how many|count|number of|total|list(?:\s+all)?|show(?:\s+me)?(?:\s+all)?|any|and|what about|how about|only|just|filter(?:\s+to)?|limit(?:\s+to)?)\b\s*/i;

/** Status/type/origin modifier words parseJobFilters already extracts — not part of the topic. */
const JOB_TOPIC_MODIFIER_WORDS = new Set([
  'active', 'open', 'live', 'current', 'currently', 'closed', 'filled', 'draft', 'archived',
  'remote', 'internal', 'external', 'intern', 'internship',
  'full-time', 'fulltime', 'part-time', 'parttime', 'contract', 'temporary', 'freelance',
]);

/** Filler words that carry no topic meaning. */
const JOB_TOPIC_FILLER_WORDS = new Set([
  'the', 'all', 'our', 'any', 'new', 'total', 'of', 'do', 'we', 'have',
  'one', 'ones', 'those', 'them', 'full', 'part', 'time',
]);

/** "ml and ai jobs" names two topics — split on these instead of stopping. */
const JOB_TOPIC_SEPARATOR_WORDS = new Set(['and', 'or', '&']);

/**
 * Words that end a topic capture — the capture must not run past these into the rest of
 * the sentence ("jobs for react are open" must not capture "react are open").
 */
const JOB_TOPIC_STOP_WORDS = new Set([
  'are', 'is', 'there', 'available', 'open', 'opening', 'openings',
  'in', 'at', 'with', 'over', 'above', 'below', 'under',
  'right', 'now', 'currently', 'today',
]);

/**
 * "jobs of/for/related to X" — topic follows the noun + preposition, not before it. No
 * "with" branch: "jobs with X" is parseSkillFilter's territory ("jobs with React", "jobs
 * with 3-5 years experience") — treating it as a topic too would search on a skill/
 * experience phrase that's already a real filter.
 */
const JOB_TOPIC_AFTER_NOUN_RE =
  /\b(?:jobs?|openings?|vacanc(?:y|ies)|positions?|postings?|roles?)\s+(?:of|for|related\s+to)\s+([^?.!]+)/i;

/** "X related jobs" — topic word(s) immediately precede "related" + the job noun. */
const JOB_TOPIC_RELATED_BEFORE_RE =
  /\b([A-Za-z][\w+#.-]*(?:\s+[A-Za-z][\w+#.-]*){0,2})\s+related\s+(?:jobs?|openings?|vacanc(?:y|ies)|positions?|postings?|roles?)\b/i;

/**
 * Truncate a raw capture at the first stop word / digit / sentence punctuation, split it
 * into topics on and/or/commas ("ml and ai"), then drop filler/modifier words from each.
 * Returns null (nothing left), one topic string, or an array of topics (matched as OR).
 */
function cleanJobTopicWords(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const groups = [[]];
  for (const raw of words) {
    const clean = raw.replace(/[?.!,]+$/, '');
    const lower = clean.toLowerCase();
    if (JOB_TOPIC_SEPARATOR_WORDS.has(lower)) {
      groups.push([]);
      continue;
    }
    if (!lower || JOB_TOPIC_STOP_WORDS.has(lower) || /\d/.test(lower)) break;
    groups[groups.length - 1].push(clean);
    if (/[?.!]$/.test(raw)) break; // sentence punctuation ends the topic clause
    if (raw.endsWith(',')) groups.push([]); // "ml, ai jobs" lists topics
  }
  const topics = groups
    .map((g) => g.filter((w) => {
      const lower = w.toLowerCase();
      return lower && !JOB_TOPIC_MODIFIER_WORDS.has(lower) && !JOB_TOPIC_FILLER_WORDS.has(lower);
    }).join(' ').trim())
    .filter(Boolean);
  const unique = [...new Set(topics.map((t) => t.toLowerCase()))].map(
    (lower) => topics.find((t) => t.toLowerCase() === lower),
  );
  if (!unique.length) return null;
  return unique.length === 1 ? unique[0] : unique;
}

/** Conversational openers ("ok what about next") that must not hide a follow-up lead-in. */
const FOLLOWUP_OPENER_RE = /^\s*(?:ok(?:ay)?|so|alright|hmm+|then)\b[,.!\s]*/i;

/** Lead-ins whose bare remainder is a topic swap: "what about ai" after a job count. */
const FOLLOWUP_TOPIC_LEADIN_RE = /^\s*(?:and|what about|how about|only|just)\s+/i;

/**
 * Pull a topic word/phrase out of a job count/list question into a search term — "how many
 * **AI** jobs", "how many jobs of **react**", "**react** related jobs". Without this, a
 * topic that isn't a recognized status/type/company/skill filter was silently dropped, so
 * "how many AI jobs" counted every job instead of just AI jobs.
 * @param {string} message
 * @returns {string|string[]|null}
 */
export function extractJobTopicKeyword(message) {
  const raw = String(message || '').trim();

  // Strip a leading count/list command phrase up front so every pattern below reasons
  // about "the rest of the sentence" without separately re-checking for it.
  const leadinMatch = raw.match(JOB_TOPIC_LEADIN_RE);
  const rest = leadinMatch ? raw.slice(leadinMatch[0].length) : raw;

  // "jobs of/for/with/related to X" — a strong-enough marker on its own; no leadin needed.
  const afterNoun = rest.match(JOB_TOPIC_AFTER_NOUN_RE);
  if (afterNoun) return cleanJobTopicWords(afterNoun[1]);

  // "X related jobs" — likewise unambiguous without a leadin phrase.
  const relatedBefore = rest.match(JOB_TOPIC_RELATED_BEFORE_RE);
  if (relatedBefore) return cleanJobTopicWords(relatedBefore[1]);

  // Default: topic word(s) between the (already-stripped) leadin and the job noun — e.g.
  // "AI jobs", "react developer positions". Requires the leadin: without one, leftover text
  // before a job noun isn't reliably a topic (a salary-ranking question like "what's the
  // highest paying job" would otherwise mistake "what's the highest paying" for one).
  if (!leadinMatch) return null;
  const nounMatch = rest.match(JOB_TOPIC_NOUN_RE);
  if (!nounMatch) return null;
  return cleanJobTopicWords(rest.slice(0, nounMatch.index));
}

/**
 * Unambiguous "every status" phrases — these win even over a status word parseJobFilters
 * also caught, e.g. "including closed" mentions "closed" but means the opposite of a
 * status:'Closed'-only filter. Deliberately does NOT include a bare "all" — "show me all
 * jobs" / "list all AI jobs" use "all" as a generic quantifier ("every one"), not a request
 * for every status, and must still default to Active like the Jobs page does.
 */
const JOB_ALL_STATUSES_STRONG_RE =
  /\ball\s+status(?:es)?\b|\bevery\s+status(?:es)?\b|\bany\s+status(?:es)?\b|\bincluding\s+closed\b|\bever\s+posted\b/i;

const JOB_SUBJECT_RE =
  /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?)\b/i;

/**
 * "roles" is a job noun ("how many AI roles"), but the same word is also the fetch_roles
 * tool's own vocabulary (RBAC roles) — "list roles and permissions", "user/system/admin
 * roles" must not be stolen into a job query just because "roles" appears.
 */
const JOB_ROLES_NOUN_RE = /\broles?\b/i;
const NON_JOB_ROLES_RE = /\b(?:user|system|admin)\s+roles?\b|\broles?\s+and\s+permissions\b/i;

/**
 * True if the message names a job-flavored noun — the usual set (jobs/openings/vacancies/
 * positions/postings), or "roles" when it isn't obviously RBAC vocabulary instead.
 * @param {string} text
 * @returns {boolean}
 */
export function hasJobSubjectNoun(text) {
  const t = String(text || '');
  if (JOB_SUBJECT_RE.test(t)) return true;
  return JOB_ROLES_NOUN_RE.test(t) && !NON_JOB_ROLES_RE.test(t);
}

const COUNT_INTENT_RE =
  /\b(how many|count|number of|total)\b/i;

const FOLLOWUP_FILTER_RE =
  /^\s*(?:and|what about|how about|only|just|show(?:\s+me)?|filter(?:\s+to)?|limit(?:\s+to)?|also|with|over|above|pay(?:ing)?|salary|require|requiring)\b/i;

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
  const t = String(message || '').replace(FOLLOWUP_OPENER_RE, '').trim();
  message = t;
  const lower = t.toLowerCase();

  let originMatch = t.match(/^\s*(?:and|what about|how about|only|just|show(?:\s+me)?|filter(?:\s+to)?|limit(?:\s+to)?)\s+(external|internal)\b/i);
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

  // A topic named in the follow-up itself replaces the inherited one — "how many ai jobs"
  // then "what about react jobs?" must search 'react', not keep 'ai' from ctx.
  // A bare "what about ai" has no job noun for extractJobTopicKeyword to anchor on, but in
  // a follow-up the remainder itself is the new topic. Modifier/origin/skill/salary words
  // are dropped by cleanJobTopicWords, so "what about remote" keeps the inherited topic.
  const bareLeadin = originMatch ? null : t.match(FOLLOWUP_TOPIC_LEADIN_RE);
  const topic =
    extractJobTopicKeyword(message) ||
    (bareLeadin && !hasJobSubjectNoun(t) ? cleanJobTopicWords(t.slice(bareLeadin[0].length)) : null);
  if (topic) mergedFilters.search = topic;

  // An unambiguous "every status" phrase in the follow-up itself overrides the inherited
  // status too, same as a fresh question — "and including closed?" means 'all', not
  // whatever status the prior turn was scoped to.
  if (JOB_ALL_STATUSES_STRONG_RE.test(message)) {
    mergedFilters.status = 'all';
  }

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
  if (!hasJobSubjectNoun(t)) return false;
  if (looksLikeJobRankingQuery(t)) return false;
  if (COUNT_INTENT_RE.test(t)) return true;
  if (detectListIntent(t)) return true;
  if (ANY_JOB_QUERY_RE.test(t)) return true;
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

  // Match the ATS Jobs page's own default: Active, unless the user named another status
  // (handled above by parseJobFilters) or explicitly asked for every status ("all statuses",
  // "any status", "including closed", "every status", "ever posted"), which maps to status
  // 'all' (no restriction).
  if (JOB_ALL_STATUSES_STRONG_RE.test(message)) {
    filters.status = 'all';
  } else if (!filters.status) {
    filters.status = 'Active';
  }

  const listIntent = detectListIntent(message);

  return {
    entity: ENTITY_JOB,
    operation: 'FILTER',
    intent: listIntent ? 'list' : 'count',
    filters,
    limit: listIntent ? 50 : 0,
  };
}
