// src/services/chatAssistant/personProfile/preRouter.js
//
// Runs BEFORE tool routing, on the raw user message. A bare "1" is not a person
// name, so it must never reach the model — and referenceResolver's ORDINAL_RE
// cannot help: it requires an ordinal plus a noun from a list with no person
// nouns in it, and it is not exported.
//
// Indices bind to the STORED matches array, never a re-derived one.

const INDEX_RE   = /^\s*#?\s*(\d{1,2})\s*[.)]?\s*$/;
const ORDINAL_RE = /^\s*(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+(?:one|item|person|user|employee|candidate|student|mentor|result|option))?\s*[.!]?\s*$/i;
const CANCEL_RE  = /^\s*(neither|none(?:\s+of\s+(?:those|them))?|cancel|nevermind|never\s+mind|forget\s+it|stop)\s*[.!]?\s*$/i;
const FULL_RE    = /\b(everything|full\s+profile|complete\s+profile|entire\s+profile|all\s+(?:the\s+)?(?:details|info|information|fields))\b/i;
const THIS_ONE_RE = /\b(this one|that one|that'?s the one|that is the one)\s*[.!]?\s*$/i;
const USER_PICK_RE = /^\s*(?:the\s+)?(?:this|that)\s+one\s*[.!]?\s*$/i;

const WORD_INDEX = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
                     fourth: 4, '4th': 4, fifth: 5, '5th': 5 };

/**
 * @param {string} message raw user turn
 * @param {{userId:any,name:string,roles:string[]}[]} matches stored candidate list
 */
export function matchSelection(message, matches = []) {
  const text = String(message || '').trim();
  if (!text) return { kind: 'unrelated' };

  if (CANCEL_RE.test(text)) return { kind: 'cancel' };

  const pick = (n) =>
    n >= 1 && n <= matches.length
      ? { kind: 'select', userId: matches[n - 1].userId }
      : { kind: 'reask' };

  const idx = text.match(INDEX_RE);
  if (idx) return pick(Number(idx[1]));

  const ord = text.match(ORDINAL_RE);
  if (ord) return pick(WORD_INDEX[ord[1].toLowerCase()]);

  if (USER_PICK_RE.test(text) && matches.length === 1) {
    return { kind: 'select', userId: matches[0].userId };
  }

  const stripped = text.replace(THIS_ONE_RE, '').trim();
  if (stripped && stripped !== text) {
    const inner = matchSelection(stripped, matches);
    if (inner.kind === 'select' || inner.kind === 'reask' || inner.kind === 'cancel') return inner;
  }

  const lower = text.toLowerCase();
  const named = matches.filter((m) => String(m.name || '').toLowerCase() === lower);
  if (named.length === 1) return { kind: 'select', userId: named[0].userId };

  return { kind: 'unrelated' };
}

/** Backend owns the brief/full decision so it is testable; the LLM owns wording. */
export function detectDepth(message) {
  return FULL_RE.test(String(message || '')) ? 'full' : 'brief';
}
