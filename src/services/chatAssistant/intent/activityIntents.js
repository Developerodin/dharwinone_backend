/** Pronoun follow-ups inherit the conversation entity subject. */
export const PRONOUN_RE = /\b(he|him|his|she|her|they|them|their)\b/i;

const JOB_APPLICATION_RE =
  /\b(applied to|has applied|have applied|did apply|job applications?|any jobs?\b|what jobs?\s+(?:has|have|did)|what positions?\s+(?:has|have|did)|show me .+? applications?)\b/i;

const INTERVIEW_ACTIVITY_RE =
  /\b(interviewed|interviews?\s+(?:for|with|about)|was interviewed|been interviewed)\b/i;

const EXISTENCE_CHALLENGE_RE =
  /\b(you don'?t have|don'?t you have|do you have|you have this|isn'?t in the system|not in (?:the )?system)\b/i;

const APPLICATION_COUNT_CHALLENGE_RE =
  /\b(are you sure|is that (?:correct|right)|confirm|verify|double[- ]check)\b/i;

/** Pronoun / deictic list follow-ups after an application count ("list them"). */
export const APPLICATION_LIST_FOLLOWUP_RE =
  /^\s*(list|show)(\s+(me|all|of))?\s+(them|those|these)\.?\s*$|^\s*show\s+(all\s+)?of\s+them\.?\s*$/i;

const APPLICATION_STATUS_FOLLOWUP_RE =
  /\b(?:still|currently)\s+applied\b/i;

const APPLICATION_HIRED_FOLLOWUP_RE =
  /\b(?:which|what)\s+(?:one|ones|jobs?|positions?)\b/i;

/** Entity switch while preserving conversational domain/intent — "what about Khushi?" */
const WHAT_ABOUT_ENTITY_SWITCH_RE =
  /^\s*what about\s+(.+?)\??\s*$/i;

const AND_ENTITY_SWITCH_RE =
  /^\s*and\s+(.+?)\??\s*$/i;

const ENTITY_SWITCH_STOPWORDS_RE =
  /\b(how|many|which|what|did|does|has|have|is|are|any|other|still|currently|list|show|them|those|she|he|they)\b/i;

const WHAT_ABOUT_DEICTIC_RE =
  /^\s*(?:what about|and)\s+(?:it|them|those|these|him|her)\??\s*$/i;

const WHAT_ABOUT_JOB_SWITCH_RE =
  /^\s*(?:ok\s+)?what about\s+jobs?\s*[.!?]?\s*$/i;

const EXISTENCE_TARGET_RE =
  /\b(this employee|that employee|this person|that person|him\b|her\b|them\b)\b/i;

/** Name extraction patterns for person-scoped application queries. Order matters — most specific first. */
const APPLICATION_NAME_PATTERNS = [
  // "how many jobs is Khushi Parmar currently applied to"
  /\bhow many jobs?\s+(?:is|are)\s+(.+?)\s+currently\s+applied\b/i,
  // "how many jobs has Khushi Parmar been hired for"
  /\bhow many jobs?\s+(?:has|have|did)\s+(.+?)\s+(?:been\s+)?hired\b/i,
  // "how many jobs does Khushi Parmar has applied to"
  /\bhow many jobs?\s+(?:does|has|have|did)\s+(.+?)\s+(?:has\s+|have\s+|had\s+)?applied\b/i,
  // "how many jobs has Khushi Parmar applied to"
  /\bhow many jobs?\s+(?:has|have|did)\s+(.+?)\s+(?:has\s+|have\s+|had\s+)?applied\b/i,
  // "which jobs has Khushi Parmar applied to"
  /\bwhich jobs?\s+(?:has|have|did)\s+(.+?)\s+(?:has\s+|have\s+|had\s+)?applied\b/i,
  // "how many applications does X have"
  /\bhow many applications?\s+(?:does|has|have|did)\s+(.+?)\s+have\b/i,
  // "what jobs/positions did X apply for"
  /\bwhat (?:jobs?|positions?)\s+(?:has|have|did)\s+(.+?)\s+(?:applied|apply)\b/i,
  // "show me X's applications"
  /\bshow me\s+(.+?)'?s?\s+applications?\b/i,
  // "has X applied to any jobs"
  /\b(?:has|have|did)\s+(.+?)\s+applied to any jobs?\b/i,
  // legacy / existence phrasing
  /^(?:ok[, ]*)?(?:has|have|did)\s+(.+?)\s+applied\b/i,
  /^(.+?)\s+(?:you don'?t have|don'?t you have|do you have)\b/i,
  /^(.+?)\s*,\s*(?:you don'?t have|don'?t you have|do you have)\b/i,
  /\b(?:for|about)\s+(.+?)\s+(?:applied|applications?)\b/i,
];

/**
 * Detect "what about X?" / "and X?" entity switches that preserve the current domain.
 *
 * @param {string} message
 * @param {{ applicationQueryContext?: object|null }} [ctx]
 * @returns {{ name: string, domain: string }|null}
 */
export function detectWhatAboutEntitySwitch(message, ctx = {}) {
  const text = String(message || '').trim();
  if (!text || WHAT_ABOUT_DEICTIC_RE.test(text) || WHAT_ABOUT_JOB_SWITCH_RE.test(text)) {
    return null;
  }

  const appCtx = ctx.applicationQueryContext;
  const lastDomain = appCtx?.lastQueryDomain ?? appCtx?.domain ?? null;
  const inApplicationsThread =
    (appCtx?.applicantName && (lastDomain ?? 'applications') === 'applications')
    || (lastDomain === 'applications' && (appCtx?.operation != null || appCtx?.lastTotal != null));

  if (!inApplicationsThread) {
    return null;
  }

  const hit = text.match(WHAT_ABOUT_ENTITY_SWITCH_RE) || text.match(AND_ENTITY_SWITCH_RE);
  if (!hit?.[1]) return null;

  const name = cleanExtractedName(hit[1]);
  if (!name || name.length < 2 || ENTITY_SWITCH_STOPWORDS_RE.test(name)) return null;

  return { name, domain: appCtx.domain ?? 'applications' };
}

/**
 * True when the message continues a person-scoped application thread.
 *
 * @param {string} message
 * @param {{ applicationQueryContext?: object|null, currentEntitySubject?: object|null }} [ctx]
 */
export function isApplicationContextFollowUp(message, ctx = {}) {
  const text = String(message || '').trim();
  if (!text) return false;

  const hasAppCtx = Boolean(ctx.applicationQueryContext?.applicantName);
  const hasSubject = Boolean(ctx.currentEntitySubject?.name);
  if (!hasAppCtx && !hasSubject) return false;

  if (APPLICATION_LIST_FOLLOWUP_RE.test(text)) return true;
  if (detectApplicationStatusFilter(text)) return true;
  if (detectWhatAboutEntitySwitch(text, ctx)) return true;

  if (usesPronoun(text) && /\b(hired|apply|applied)\b/i.test(text)) {
    return true;
  }

  if (/\bapplied\b/i.test(text) && (/\bhow many\b/i.test(text) || usesPronoun(text))) {
    return true;
  }

  if (APPLICATION_HIRED_FOLLOWUP_RE.test(text) && /\b(hired|applied)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * @param {string} message
 * @returns {'Applied'|'Hired'|null}
 */
export function detectApplicationStatusFilter(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (
    /\b(?:been|was|got|get)\s+hired\b/i.test(text)
    || /\bdid\s+(?:she|he|they|\w+)\s+get\s+hired\b/i.test(text)
    || /\bhired\s+for\b/i.test(text)
    || /\bhow many jobs?\s+(?:has|have|did)\s+.+\s+(?:been\s+)?hired\b/i.test(text)
    || (APPLICATION_HIRED_FOLLOWUP_RE.test(text) && /\bhired\b/i.test(text))
  ) {
    return 'Hired';
  }

  if (
    APPLICATION_STATUS_FOLLOWUP_RE.test(text)
    || /\bcurrently\s+applied(?:\s+to)?\b/i.test(text)
    || /\b(?:is|are)\s+.+\s+currently\s+applied(?:\s+to)?\b/i.test(text)
    || /\bhow many jobs?\s+(?:is|are)\s+.+\s+currently\s+applied(?:\s+to)?\b/i.test(text)
    || /\bhow many\b[\s\S]{0,40}\b(?:has|have)\s+(?:she|he|they|\w+)\s+still\s+applied\b/i.test(text)
  ) {
    return 'Applied';
  }

  return null;
}

/**
 * @param {string} message
 * @param {{ applicationQueryContext?: object|null, currentEntitySubject?: object|null }} [ctx]
 * @returns {'job_applications'|'interviews'|'employee_existence'|null}
 */
export function detectActivityIntent(message, ctx = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (isApplicationContextFollowUp(text, ctx)) {
    return 'job_applications';
  }

  if (APPLICATION_COUNT_CHALLENGE_RE.test(text)) {
    if (ctx.applicationQueryContext?.applicantName || ctx.currentEntitySubject?.name) {
      return 'job_applications';
    }
  }

  if (EXISTENCE_CHALLENGE_RE.test(text) && (EXISTENCE_TARGET_RE.test(text) || /\bemployee\b/i.test(text))) {
    return 'employee_existence';
  }

  if (
    JOB_APPLICATION_RE.test(text)
    || (/\bapplied\b/i.test(text) && /\bjobs?\b/i.test(text))
    || (/\bapplications?\b/i.test(text) && /\b(?:how many|which|what|show me)\b/i.test(text))
  ) {
    return 'job_applications';
  }

  if (INTERVIEW_ACTIVITY_RE.test(text)) {
    return 'interviews';
  }

  return null;
}

/**
 * @param {string} message
 * @param {{ applicationQueryContext?: object|null }} [ctx]
 * @returns {'count'|'list'|'existence'}
 */
export function detectApplicationQueryOperation(message, ctx = {}) {
  const text = String(message || '').trim();
  if (!text) return 'count';

  const entitySwitch = detectWhatAboutEntitySwitch(text, ctx);
  if (entitySwitch) {
    const prevOp = ctx.applicationQueryContext?.operation;
    if (prevOp === 'existence' || prevOp === 'count') return 'list';
    return prevOp || 'list';
  }

  if (APPLICATION_LIST_FOLLOWUP_RE.test(text)) return 'list';
  if (/\bwhich (?:one|ones?|jobs?|positions?)\b/i.test(text)) return 'list';
  if (/\bwhat (?:jobs?|positions?)\b/i.test(text)) return 'list';
  if (/\bshow me\b.*\bapplications?\b/i.test(text)) return 'list';
  if (/\blist\b.*\bapplications?\b/i.test(text)) return 'list';
  if (/\b(?:has|have|did)\s+(?:she|he|they|\w+)\s+applied(?:\s+for|\s+to)?\s+any\b/i.test(text)) {
    return 'existence';
  }
  if (/\bdid\s+(?:she|he|they|\w+)\s+get\s+hired\b/i.test(text)) return 'list';

  return 'count';
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function usesPronoun(message) {
  return PRONOUN_RE.test(String(message || ''));
}

/**
 * Pull a person name from activity phrasing when present.
 * @param {string} message
 * @returns {string|null}
 */
export function extractPersonNameFromMessage(message) {
  const text = String(message || '').trim();
  if (!text || usesPronoun(text)) return null;

  for (const re of APPLICATION_NAME_PATTERNS) {
    const hit = text.match(re);
    if (!hit?.[1]) continue;
    const name = cleanExtractedName(hit[1]);
    if (name && name.length >= 2) return name;
  }

  return null;
}

function cleanExtractedName(raw) {
  return String(raw || '')
    .replace(/\?+$/, '')
    .replace(/\b(this|that|the)\s+employee\b/i, '')
    .replace(/['']s\s+applications?\s*$/i, '')
    .replace(/\s+applications?\s*$/i, '')
    .replace(/\b(any|some)\s+jobs?\b.*$/i, '')
    .replace(/\b(to|for)\s*$/i, '')
    .replace(/\b(does|has|have|did)\s*$/i, '')
    .trim();
}

/**
 * Resolve who the activity question is about.
 *
 * @param {string} message
 * @param {'job_applications'|'interviews'|'employee_existence'|null} intent
 * @param {{ currentEntitySubject?: object|null, personConversationState?: object|null, applicationQueryContext?: object|null }} ctx
 * @returns {{ name?: string|null, userId?: string|null, employeeId?: string|null, fromContext?: boolean }|null}
 */
export function resolveActivityEntitySubject(message, intent, ctx = {}) {
  const text = String(message || '').trim();

  const entitySwitch = detectWhatAboutEntitySwitch(text, ctx);
  if (entitySwitch && intent === 'job_applications') {
    return { name: entitySwitch.name, userId: null, fromContext: false };
  }

  if (intent === 'job_applications' && ctx.applicationQueryContext?.applicantName) {
    const appCtx = ctx.applicationQueryContext;
    if (
      APPLICATION_COUNT_CHALLENGE_RE.test(text)
      || isApplicationContextFollowUp(text, ctx)
    ) {
      return {
        name: appCtx.applicantName,
        userId: appCtx.userId ?? null,
        fromContext: true,
      };
    }
  }

  const stored = ctx.currentEntitySubject;
  const personState = ctx.personConversationState;
  const contextSubject = stored || (personState?.entityId
    ? {
        userId: String(personState.entityId),
        name: personState.name,
        entityType: personState.entityType || 'user',
      }
    : null);

  if (usesPronoun(message) && contextSubject) {
    return { ...contextSubject, fromContext: true };
  }

  const extracted = extractPersonNameFromMessage(message);
  if (extracted) {
    if (
      contextSubject?.name &&
      contextSubject.name.toLowerCase().includes(extracted.toLowerCase())
    ) {
      return { ...contextSubject, name: contextSubject.name, fromContext: true };
    }
    return { name: extracted, userId: contextSubject?.userId ?? null, fromContext: false };
  }

  if (contextSubject?.name) {
    const lower = message.toLowerCase();
    const nameLower = contextSubject.name.toLowerCase();
    if (lower.includes(nameLower)) {
      return { ...contextSubject, fromContext: true };
    }
  }

  if (contextSubject && intent === 'employee_existence' && !extracted) {
    return { ...contextSubject, fromContext: true };
  }

  return null;
}
