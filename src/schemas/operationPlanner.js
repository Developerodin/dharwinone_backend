/**
 * Derive StructuredQuery operations from natural-language phrasing.
 */

const COUNT_RE = /\b(how many|count|number of|total)\b/i;
const LIST_RE =
  /\b(list|show|give me|display|fetch|get me|who are|who is|tell me about|names? of)\b/i;
const COMPOUND_RE =
  /\b(how many|count|number of)\b[\s\S]{0,80}\b(and|&)\b[\s\S]{0,40}\b(who|which|names?|list|show|they|them)\b/i;
const COMPOUND_WHO_RE = /\bhow many\b[\s\S]{0,80}\bwho\b/i;

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
  if (/\btell me about\b/i.test(text)) {
    return ['list'];
  }
  if (hasList) {
    return ['list'];
  }

  return ['list'];
}
