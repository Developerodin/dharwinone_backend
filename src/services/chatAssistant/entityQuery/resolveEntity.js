import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

import { parseDesignationFromMessage } from '../conversationalEntity/resolveTitleAmbiguity.js';

const ENTITY_NOUN_RE =
  /\b(employees?|people|staff|headcount|workforce|team members?|personnel)\b/i;

/** Signals that name the employee domain outright — safe with no entity noun. */
const EMPLOYEE_ONLY_SIGNAL_RE =
  /\b(resigned|ex[\s-]?employees?|current employees?|employee\s*ids?|dbs\d+)\b/i;

/**
 * Attribute words shared with jobs, candidates and interviews. They mean
 * "employees" only when the message also names the entity.
 *
 * Measured 2026-08-11 with these treated as strong signals on their own:
 * "how many jobs are open in the engineering department", "list candidates who
 * joined in march", "what designation does this job require" and "how many
 * interviews scheduled for the sales department" all resolved to `employees`.
 * runEmployeeEntityQuery returns deterministic:true, so a misroute never reaches
 * the LLM — the wrong answer is terminal.
 */
const SHARED_ATTRIBUTE_SIGNAL_RE =
  /\b(retired|former|joining date|joined in|department|designation)\b/i;

const VALUE_ONLY_HR_SIGNAL_RE = /\b(unpaid|paid|salaried|compensation)\b/i;

/**
 * Employment-status words that continue an established employee scope
 * ("how many are active?" right after an employee answer).
 *
 * Bare `current` is deliberately absent: "show me the current sprint" names no
 * competing entity noun, so it would slip past the guards below and be answered
 * with an employee count. entityQuery is terminal — a misroute there never
 * reaches the LLM to be corrected.
 */
const STATUS_ONLY_HR_SIGNAL_RE = /\b(active|resigned|currently[- ]working|on[- ]roll)\b/i;

const BARE_EMPLOYEE_RE =
  /\b(employees?|people|staff|headcount|workforce|personnel|team members?)\b/i;
const ROLE_LANGUAGE_RE =
  /\b(managers?|recruiters?|candidates?|students?|administrators?|agents?|mentors?|referrers?)\b/i;

/**
 * Nouns belonging to another module. A fragment naming one of these has changed
 * the subject, however employee-flavoured the rest of it reads.
 */
const COMPETING_ENTITY_RE =
  /\b(jobs?|openings?|vacanc(?:y|ies)|applications?|interviews?|meetings?|tasks?|projects?|teams?|leaves?|attendance|invoices?|subscriptions?)\b/i;

const UNSET = Symbol('unset');
let _chatbotConfigOverride = UNSET;

/** ponytail: lazy require so tests can override config before first gate evaluation. */
function getChatbotConfig() {
  if (_chatbotConfigOverride !== UNSET) return _chatbotConfigOverride;
  return require('../../../config/config.js').default?.chatbot;
}

/** @internal Test hook for entityQueryUsers ponytail gate. */
export function __setChatbotConfigForTest(chatbot) {
  _chatbotConfigOverride = chatbot === undefined ? UNSET : chatbot;
}

export function hasHrSignals(message) {
  const text = String(message || '');
  // Application-status follow-ups ("still applied") are not workforce queries.
  if (/\b(?:still|currently)\s+applied\b/i.test(text)) return false;
  if (EMPLOYEE_ONLY_SIGNAL_RE.test(text)) return true;
  if (/\b(who works as|employees with (?:position|designation|title))\b/i.test(text)) return true;
  if (/\bhow many\b/i.test(text) && parseDesignationFromMessage(text)) return true;
  if (!ENTITY_NOUN_RE.test(text)) return false;
  return SHARED_ATTRIBUTE_SIGNAL_RE.test(text) || VALUE_ONLY_HR_SIGNAL_RE.test(text);
}

/**
 * Shared users vs employees router — runs before entity gates.
 *
 * @param {string} message
 * @param {object|null} [lastContext]
 * @returns {'users'|'employees'|null}
 */
export function resolveEntity(message, lastContext = null) {
  const text = String(message || '').trim();
  if (!text) return null;

  // Priority 1: follow-up inheritance
  const isFollowUp = /^(list them|show them|who are they|and who)\b/i.test(text);
  if (isFollowUp && lastContext?.entity && !hasHrSignals(text)) {
    return lastContext.entity;
  }

  // Priority 1.5: alias-only continuation of an employee scope already on the
  // table. "and paid?" names no entity, so hasHrSignals() rightly refuses it
  // standing alone — that noun gate is what keeps job and interview queries out
  // of here. With lastContext.entity === 'employees' the fragment is no longer
  // ambiguous, and refusing it is worse than a misroute: the question escapes to
  // the LLM, which answers a compensation count off a roster it invented.
  // Status fragments ("how many are active?", "and the resigned ones") continue an
  // employee scope for the same reason.
  if (
    lastContext?.entity === 'employees' &&
    (VALUE_ONLY_HR_SIGNAL_RE.test(text) || STATUS_ONLY_HR_SIGNAL_RE.test(text)) &&
    !COMPETING_ENTITY_RE.test(text) &&
    !ROLE_LANGUAGE_RE.test(text)
  ) {
    return 'employees';
  }

  // Priority 2: HR signals → employees
  if (hasHrSignals(text)) return 'employees';

  // Priority 3: bare employees/people without HR → users when users pipeline enabled
  if (BARE_EMPLOYEE_RE.test(text) && !hasHrSignals(text)) {
    return getChatbotConfig()?.entityQueryUsers ? 'users' : 'employees';
  }

  // Priority 4: role language → users
  if (ROLE_LANGUAGE_RE.test(text)) return 'users';

  return null;
}
