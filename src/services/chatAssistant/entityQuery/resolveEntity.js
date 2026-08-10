import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ENTITY_NOUN_RE =
  /\b(employees?|people|staff|headcount|workforce|team members?|personnel)\b/i;

const STRONG_HR_SIGNAL_RE =
  /\b(resigned|retired|former|ex[\s-]?employees?|current employees?|joining date|joined in|department|designation|employee\s*ids?|dbs\d+)\b/i;

const VALUE_ONLY_HR_SIGNAL_RE = /\b(unpaid|paid|salaried|compensation)\b/i;

const BARE_EMPLOYEE_RE = /\b(employees?|people|staff|headcount)\b/i;
const ROLE_LANGUAGE_RE =
  /\b(managers?|recruiters?|candidates?|students?|administrators?|agents?|mentors?|referrers?)\b/i;

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
  if (STRONG_HR_SIGNAL_RE.test(text)) return true;
  if (VALUE_ONLY_HR_SIGNAL_RE.test(text) && ENTITY_NOUN_RE.test(text)) return true;
  return false;
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
