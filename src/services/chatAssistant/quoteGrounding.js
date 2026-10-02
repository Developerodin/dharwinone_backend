/**
 * Quote check for a call reply.
 *
 * Chat history stores the user and assistant text, not tool results, so a later
 * turn does not still hold the transcript. The tool ledger stores the call id
 * (not the transcript body — that would be copied into every later prompt).
 * runAgent reloads that call for this check only, using the same record read
 * and renderTranscript as get_call_takeaways, and does not call the model again.
 * The previous assistant message is not evidence. A quote the user typed is not
 * evidence: it is checked against the reloaded transcript, and if it differs
 * the reply follows the transcript.
 *
 * explicit: the claim's words are in the transcript.
 * inferred: the claim contains a transcript sentence and adds words.
 * absent: the transcript was checked and the claim is not in it.
 * no_transcript: there is no transcript to check. That is not "absent".
 * Extractor null is not absent; that state is decided by the caller that has
 * the transcript, not by a missing takeaway field.
 */

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteOccurs(transcript, quote) {
  const needle = normalize(quote);
  if (needle.length < 3) return false;
  const hay = normalize(transcript);
  return !!hay && hay.includes(needle);
}

/**
 * @param {{ transcriptAvailable?: boolean, transcript?: string, claim?: string }} input
 * @returns {'explicit'|'inferred'|'absent'|'no_transcript'}
 */
export function speechBasis({ transcriptAvailable, transcript, claim }) {
  if (!transcriptAvailable) return 'no_transcript';
  const hay = normalize(transcript);
  if (!hay) return 'no_transcript';
  const text = normalize(claim);
  if (!text) return 'absent';
  if (hay.includes(text)) return 'explicit';
  const spoken = String(transcript ?? '').split(/\n/).map((line) => {
    const body = line
      .replace(/^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|\(\d{1,2}:\d{2}(?::\d{2})?\)|\d{1,2}:\d{2}(?::\d{2})?)\s*/, '')
      .replace(/^(?:agent|user|candidate|assistant|the candidate|the agent|the interviewer)\s*:\s*/i, '');
    return normalize(body);
  }).filter((s) => s.length >= 12);
  if (spoken.some((s) => text.includes(s) && text !== s)) return 'inferred';
  return 'absent';
}

function transcriptText(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.transcriptAvailable === false || result.transcriptState === 'no_transcript') {
    return { transcriptAvailable: false, transcript: '' };
  }
  const raw = result.transcript;
  if (result.transcriptAvailable === true && typeof raw === 'string' && raw.trim()) {
    return { transcriptAvailable: true, transcript: raw };
  }
  if (typeof raw === 'string' && raw.trim() && result.transcriptAvailable !== false) {
    return { transcriptAvailable: true, transcript: raw };
  }
  return null;
}

/** Tool results from this turn that loaded, or explicitly lacked, a call transcript. */
export function collectTranscriptContexts(results) {
  const contexts = [];
  for (const result of results || []) {
    const ctx = transcriptText(result);
    if (ctx) contexts.push(ctx);
  }
  return contexts;
}

/**
 * Call id to reload later. The transcript body is not stored: the ledger is
 * replayed into later prompts, and a long transcript must not ride along.
 * @param {object} output tool result
 * @returns {{callId:string, transcriptLoaded:boolean}|null}
 */
export function transcriptLedgerFields(output) {
  if (!output || typeof output !== 'object') return null;
  const call = output.call;
  const id = call && typeof call === 'object' ? (call.id ?? call.executionId) : null;
  if (typeof id !== 'string' || !id.trim()) return null;
  const marked = output.transcriptState === 'no_transcript'
    || output.transcriptAvailable === true
    || output.transcriptAvailable === false
    || 'transcript' in output;
  if (!marked) return null;
  const loaded = output.transcriptAvailable !== false
    && output.transcriptState !== 'no_transcript'
    && typeof output.transcript === 'string'
    && output.transcript.trim().length > 0;
  return { callId: id.trim(), transcriptLoaded: loaded };
}

/** Most recent ledger call that loaded or lacked a transcript. */
export function latestCallTranscriptRef(ledger) {
  const entries = Array.isArray(ledger) ? ledger : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const calls = Array.isArray(entries[i]?.calls) ? entries[i].calls : [];
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      const call = calls[j];
      if (typeof call?.callId === 'string' && call.callId.trim()) {
        return { callId: call.callId.trim(), transcriptLoaded: call.transcriptLoaded === true };
      }
    }
  }
  return null;
}

/**
 * User-text keywords that mean the follow-up needs the prior call transcript.
 * Speech: said/say/says/saying, mention(ed/s), quote(d/s), transcript,
 * exact(ly), sentence, according to, stated/told, discuss(ed/ing).
 * Topics, even with none of those words: join(ing/ed/s), available/availability,
 * relocate/relocation, and agree (he/she/they/the candidate agreed, or "agree to").
 * Challenge of a prior answer: that's/that is/that was wrong or incorrect or not
 * right, you're wrong, are you sure, you misread.
 * Directory and task questions do not reload: "how many employees",
 * "list/listing employees", "show overdue tasks". A draft reply is not evidence
 * and does not override that. Ceiling: "joining" inside an HR question that is
 * not one of those directory/task phrases still reloads the prior call.
 */
const SPEECH_RE = /\b(?:said|say|says|saying|mention(?:ed|s)?|quote[ds]?|transcript|exact(?:ly)?|sentence|according to|stated|told|discuss(?:ed|ing)?)\b/i;
const CALL_TOPIC_RE = /\b(?:join(?:ing|ed|s)?|availab(?:le|ility)|relocat(?:e|ed|es|ing|ion)|(?:did|does|has|had)\s+(?:he|she|they|the candidate)\s+agree[ds]?|(?:he|she|they|the candidate)\s+agree[ds]?|agree[ds]?\s+to)\b/i;
const CHALLENGE_RE = /\b(?:that(?:'s| is| was| isn't| is not) (?:wrong|incorrect|not right)|you(?:'re| are) wrong|are you sure|you misread)\b/i;

function unrelatedDirectoryOrTasks(userText) {
  const text = String(userText || '');
  return /\bhow many employees\b/i.test(text)
    || (/\blist(?:ing)?\b/i.test(text) && /\bemployees\b/i.test(text))
    || /\boverdue tasks\b/i.test(text)
    || /\bshow overdue\b/i.test(text);
}

/** A follow-up that needs the prior call transcript. Other questions do not reload it. */
export function speechFollowUp(userText, reply) {
  const asked = String(userText || '');
  const speech = SPEECH_RE.test(asked);
  const challenge = CHALLENGE_RE.test(asked);
  if (unrelatedDirectoryOrTasks(asked) && !speech && !challenge) return false;
  if (speech || challenge || CALL_TOPIC_RE.test(asked)) return true;
  return SPEECH_RE.test(String(reply || ''));
}

const QUOTE_RE = /"([^"\n]{3,400})"|“([^”\n]{3,400})”/g;
const SAID_RE = /\b(?:the candidate|the agent|the interviewer|the person called|they|he|she)\s+(?:said|mentioned|asked|told|stated)(?:\s+that)?\s+([^."\n]{8,220})/gi;
const ACCORDING_RE = /\baccording to\s+(?:the candidate|the interviewer|the agent|him|her|them)\s*,?\s+([^."\n]{8,220})/gi;
const SPEAKER_DENIAL_RE = /\b(?:he|she|they|the candidate|the interviewer|the agent|the person called)\s+(?:did not|didn't|does not|doesn't|never)\s+(?:say|said|mention|mentioned|state|stated|tell|told)\s+(?:that\s+|about\s+)?([^.\n]{3,180})/gi;
const DENIAL_RE = /\b(?:the transcript|it)\s+(?:did not|didn't|does not|doesn't)\s+(?:capture|include|contain|mention|record)\s+([^.\n]{3,160})/gi;
const TRANSCRIPT_SAYS_RE = /\bthe transcript\s+(?:says|said|shows|states)\s+(?:that\s+)?([^.\n]{3,180})/gi;
const USER_CLAIM_RE = /"([^"\n]{3,400})"|“([^”\n]{3,400})”|\b(?:said|mentioned|stated|told)\s+(?:that\s+)?([^."\n]{8,180})/gi;

const NO_TRANSCRIPT = 'No transcript is available.';

function spokenLines(transcript) {
  return String(transcript ?? '').split(/\n/).map((line) => {
    const trimmed = String(line ?? '').trim();
    const body = trimmed
      .replace(/^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|\(\d{1,2}:\d{2}(?::\d{2})?\)|\d{1,2}:\d{2}(?::\d{2})?)\s*/, '')
      .replace(/^(?:agent|assistant|interviewer|user|candidate|the candidate|the agent|the interviewer)\s*:\s*/i, '')
      .trim();
    const who = /^(?:\[.*?\]\s*)?(?:agent|assistant|interviewer)\b/i.test(trimmed) ? 'The agent' : 'The candidate';
    return { body, norm: normalize(body), who };
  }).filter((line) => line.norm.length >= 12);
}

/**
 * A denial is false only when every content word of the claim is a whole word
 * in one transcript line, or a prefix of that word (join / joining). The
 * replacement is the line itself, never the claim. A claim that adds a word
 * the line does not have (Monday) stays absent.
 */
function lineForDenial(claim, lines) {
  const words = normalize(claim).split(' ').filter((word) => word.length >= 4);
  if (!words.length) return null;
  let best = null;
  for (const line of lines) {
    const lineWords = line.norm.split(' ').filter((word) => word.length >= 4);
    const all = words.every((word) => lineWords.some((lineWord) => (
      lineWord === word || lineWord.startsWith(word) || word.startsWith(lineWord)
    )));
    if (all) best = line;
  }
  return best;
}

function userClaims(userText) {
  const claims = [];
  const text = String(userText ?? '');
  for (const match of text.matchAll(USER_CLAIM_RE)) {
    const claim = match[1] || match[2] || match[3];
    if (claim && claim.trim()) claims.push(claim.trim());
  }
  return claims;
}

function affirmsUngrounded(sentence, claims) {
  const norm = normalize(sentence);
  if (!norm || !claims.length) return false;
  if (claims.some((claim) => norm.includes(normalize(claim)))) return true;
  return /^(yes|yeah|yep|correct|right|exactly|true|that is right|thats right)\b/.test(norm) && norm.length <= 40;
}

function hasGroundedQuote(sentence, hay) {
  return [...sentence.matchAll(QUOTE_RE)].some((match) => quoteOccurs(hay, match[1] || match[2]));
}

function stripUngroundedQuotes(sentence, hay, hasTranscript) {
  return sentence.replace(QUOTE_RE, (match, a, b) => {
    const quote = a || b;
    if (hasTranscript && quoteOccurs(hay, quote)) return match;
    return '';
  });
}

function dropUnlessQuoted(sentence, pattern, hay, hasTranscript) {
  return sentence.replace(pattern, (match, claim) => {
    if (hasTranscript && quoteOccurs(hay, claim)) return match;
    return '';
  });
}

function scrubSentence(sentence, hay, hasTranscript, lines, ungroundedClaims) {
  let next = stripUngroundedQuotes(sentence, hay, hasTranscript);
  next = dropUnlessQuoted(next, SAID_RE, hay, hasTranscript);
  next = dropUnlessQuoted(next, ACCORDING_RE, hay, hasTranscript);
  next = dropUnlessQuoted(next, TRANSCRIPT_SAYS_RE, hay, hasTranscript);
  next = next.replace(SPEAKER_DENIAL_RE, (match, claim) => {
    if (!hasTranscript) return '';
    const line = lineForDenial(claim, lines);
    if (line && quoteOccurs(hay, line.body)) return `${line.who} said "${line.body}"`;
    return match;
  });
  next = next.replace(DENIAL_RE, (match, claim) => {
    if (!hasTranscript) return '';
    if (quoteOccurs(hay, claim)) {
      const line = lineForDenial(claim, lines);
      if (line && quoteOccurs(hay, line.body)) return `${line.who} said "${line.body}"`;
      return '';
    }
    return match;
  });
  next = next.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
  if (hasTranscript && ungroundedClaims.length && affirmsUngrounded(next, ungroundedClaims) && !hasGroundedQuote(next, hay)) {
    return '';
  }
  return next;
}

/**
 * Drop a quote or an attributed claim that is not in the loaded transcript.
 * When no transcript was loaded, those claims are removed and the reply says
 * no transcript is available, rather than that the transcript failed to capture them.
 * @param {string} reply
 * @param {Array<object>} results tool results, including a transcript reloaded for this turn
 * @param {{userText?:string}} [options] the current user message, checked against the transcript, never used as evidence
 * @returns {string}
 */
export function groundCallReply(reply, results, { userText = '' } = {}) {
  const contexts = collectTranscriptContexts(results);
  if (!reply || !contexts.length) return reply || '';
  const available = contexts.filter((c) => c.transcriptAvailable && c.transcript);
  const hasTranscript = available.length > 0;
  const hay = available.map((c) => c.transcript).join('\n');
  const lines = spokenLines(hay);
  const ungroundedClaims = userClaims(userText).filter((claim) => !hasTranscript || !quoteOccurs(hay, claim));
  const keptLines = reply.split('\n').map((line) => {
    const parts = line.split(/(?<=[.!?])\s+/);
    const kept = parts
      .map((part) => scrubSentence(part, hay, hasTranscript, lines, ungroundedClaims))
      .filter(Boolean);
    return kept.join(' ');
  });
  let out = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!hasTranscript && normalize(out) !== normalize(reply) && !/no transcript is available/i.test(out)) {
    out = [out, NO_TRANSCRIPT].filter(Boolean).join('\n').trim();
  }
  return out;
}
