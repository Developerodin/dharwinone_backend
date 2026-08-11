import { parseFiltersFromMessage } from '../entityQuery/nlResolver.js';

/** Status phrases that mean employmentStatus=all — never split on their "and". */
const BOTH_STATUS_RE =
  /\bboth\b[\s\S]{0,40}\band\b|\b(current|active|working)\s+and\s+(resigned|former|past)\b/i;

const GROUP_SIGNAL_RE =
  /\b(paid|unpaid|salaried|resigned|former|left|working|active|current|on[- ]?roll)\b/i;

/**
 * @param {Record<string, string>} filters
 * @returns {boolean}
 */
export function hasGroupSignals(filters = {}) {
  if (filters.compensationType) return true;
  if (filters.employmentStatus && filters.employmentStatus !== 'all') return true;
  return false;
}

/**
 * Parse one OR-branch from a phrase fragment.
 *
 * @param {string} phrase
 * @returns {Record<string, string>}
 */
export function parseFilterGroupFromPhrase(phrase) {
  const filters = parseFiltersFromMessage(phrase, { applyStatusDefault: false });
  if (filters.employmentStatus === 'all' && !/\ball\b/i.test(String(phrase || ''))) {
    delete filters.employmentStatus;
  }
  return filters;
}

/**
 * @param {Record<string, string>} filters
 * @returns {string}
 */
export function buildGroupId(filters = {}) {
  const parts = [];
  if (filters.compensationType) parts.push(`c:${filters.compensationType}`);
  if (filters.employmentStatus) parts.push(`s:${filters.employmentStatus}`);
  return parts.join('|') || 'default';
}

/**
 * Human label for grouped presentation — "Paid & Resigned".
 *
 * @param {Record<string, string>} filters
 * @returns {string}
 */
export function describeFilterGroup(filters = {}) {
  const parts = [];
  if (filters.compensationType === 'paid') parts.push('Paid');
  if (filters.compensationType === 'unpaid') parts.push('Unpaid');
  if (filters.employmentStatus === 'resigned') parts.push('Resigned');
  else if (filters.employmentStatus === 'current') parts.push('Working');
  return parts.join(' & ') || 'Employees';
}

/**
 * @param {Record<string, string>} filters
 * @returns {string}
 */
export function groupTableTitle(filters = {}, total = 0) {
  const label = describeFilterGroup(filters);
  const n = Number(total) || 0;
  return `${label} Employees (${n})`;
}

/**
 * Split a message into OR filter-group segments when "and" joins distinct branches.
 *
 * @param {string} userMessage
 * @returns {string[]}
 */
export function splitCompoundSegments(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text || BOTH_STATUS_RE.test(text)) return [text];

  const parts = text.split(/\s+and\s+/i);
  if (parts.length < 2) return [text];

  const segments = parts.map((p) => p.trim()).filter(Boolean);
  if (segments.length < 2) return [text];

  const groups = segments.map((seg) => parseFilterGroupFromPhrase(seg));
  const allValid = groups.every((g) => hasGroupSignals(g));
  if (!allValid) return [text];

  const keys = new Set(groups.map((g) => buildGroupId(g)));
  if (keys.size < groups.length) return [text];

  return segments;
}

/**
 * @param {string} userMessage
 * @returns {Array<{ id: string, filters: Record<string, string> }>}
 */
export function parseFilterGroupsFromMessage(userMessage) {
  const segments = splitCompoundSegments(userMessage);
  if (segments.length === 1) {
    const filters = parseFilterGroupFromPhrase(segments[0]);
    if (!hasGroupSignals(filters)) return [];
    return [{ id: buildGroupId(filters), filters }];
  }

  return segments.map((seg) => {
    const filters = parseFilterGroupFromPhrase(seg);
    return { id: buildGroupId(filters), filters };
  });
}

/**
 * Score how well a user message references a stored filter group.
 *
 * @param {string} message
 * @param {Record<string, string>} filters
 * @returns {number}
 */
export function scoreGroupMatch(message, filters = {}) {
  const text = String(message || '').toLowerCase();
  let score = 0;
  if (filters.compensationType === 'paid' && /\bpaid\b/.test(text)) score += 2;
  if (filters.compensationType === 'unpaid' && /\bunpaid\b/.test(text)) score += 2;
  if (filters.employmentStatus === 'resigned' && /\b(resigned|former|left|past)\b/.test(text)) {
    score += 2;
  }
  if (
    filters.employmentStatus === 'current' &&
    /\b(working|active|current|on[- ]?roll)\b/.test(text)
  ) {
    score += 2;
  }
  return score;
}
