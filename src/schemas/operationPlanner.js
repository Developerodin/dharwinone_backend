/**
 * Derive StructuredQuery operations from natural-language phrasing.
 */

const COUNT_RE = /\b(how many|count|number of|total)\b/i;
const LIST_RE =
  /\b(list|show|give me|display|fetch|get me|who are|who is|which employees?|tell me about|names? of)\b/i;
const COMPOUND_RE =
  /\b(how many|count|number of)\b[\s\S]{0,80}\b(and|&)\b[\s\S]{0,40}\b(who|which|names?|list|show|they|them)\b/i;
const COMPOUND_WHO_RE = /\bhow many\b[\s\S]{0,80}\bwho\b/i;

/**
 * "State of the workforce" phrasings. These ask for shape, not rows, and they
 * routinely carry a list verb ("give me an employee overview") — so summary is
 * checked before LIST_RE, or the verb wins and dumps the roster.
 */
const SUMMARY_RE =
  /\b(overview|breakdown|summar(?:y|ise|ize)|distribut(?:ion|ed)|headcount|(?:workforce|team|staff|company) size)\b/i;

/** "how is our workforce", "how are our employees doing" — no list verb, no count word. */
const BROAD_STATE_RE = /\bhow (?:is|are|'s)\b/i;

/**
 * True when the message names an operation outright. `planOperations` falls back
 * to ['list'] otherwise, which is a guess — callers holding conversation context
 * should inherit the previous turn's operation instead of taking that guess.
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
export function hasExplicitOperation(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text) return false;
  return COUNT_RE.test(text) || LIST_RE.test(text);
}

/**
 * @param {string} userMessage
 * @returns {Array<'count'|'list'|'get'>}
 */
export function planOperations(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text) return ['list'];

  const hasCount = COUNT_RE.test(text);
  const hasList = LIST_RE.test(text);
  const isCompound = COMPOUND_RE.test(text) || COMPOUND_WHO_RE.test(text);

  if (isCompound || (hasCount && hasList)) {
    return ['count', 'list'];
  }
  if (hasCount) {
    return ['count'];
  }
  if (SUMMARY_RE.test(text) || BROAD_STATE_RE.test(text)) {
    return ['count'];
  }
  if (/\btell me about\b/i.test(text)) {
    return ['list'];
  }
  if (hasList) {
    return ['list'];
  }

  // ponytail: no verb at all ("unpaid employees", "resigned staff") is a question
  // about how many, not a request for the roster. Answer with the number; the
  // follow-up path ("show me them") already turns that into a list on demand.
  return ['count'];
}
