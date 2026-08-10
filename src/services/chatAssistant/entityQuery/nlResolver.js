import { EMPLOYEE_FILTER_ALIASES } from '../../../schemas/employees/employeeFilter.registry.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest alias first so "unpaid employees" wins over "unpaid". */
const ALIAS_INDEX = (() => {
  const entries = [];
  for (const [field, canonicalMap] of Object.entries(EMPLOYEE_FILTER_ALIASES)) {
    for (const [canonical, aliases] of Object.entries(canonicalMap)) {
      for (const alias of aliases) {
        entries.push({
          field,
          canonical,
          alias: alias.toLowerCase(),
          pattern: new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i'),
        });
      }
    }
  }
  return entries.sort((a, b) => b.alias.length - a.alias.length);
})();

/**
 * Parse explicit NL filter hints from the user message.
 * Defaults employmentStatus to 'all' for broad employee queries when not explicitly stated.
 *
 * Pass `applyStatusDefault: false` when the caller has an established conversation
 * scope to fall back on — the inferred 'all' is otherwise indistinguishable from an
 * explicit "all employees" and clobbers the status the user already set.
 *
 * @param {string} userMessage
 * @param {{ applyStatusDefault?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function parseFiltersFromMessage(userMessage, { applyStatusDefault = true } = {}) {
  const text = String(userMessage || '').toLowerCase();
  if (!text) return {};

  const filters = {};
  const matchedFields = new Set();
  const hasPaid = /\bpaid\b/.test(text);
  const hasUnpaid = /\bunpaid\b/.test(text);
  const ambiguousCompensation = hasPaid && hasUnpaid;

  for (const { field, canonical, pattern } of ALIAS_INDEX) {
    if (matchedFields.has(field)) continue;
    if (field === 'compensationType' && ambiguousCompensation) continue;
    if (pattern.test(text)) {
      filters[field] = canonical;
      matchedFields.add(field);
    }
  }

  if (!filters.compensationType && !ambiguousCompensation) {
    if (/\bunpaid\s+staff\b/.test(text) || (/\bunpaid\b/.test(text) && !/\bpaid\b/.test(text))) {
      filters.compensationType = 'unpaid';
    } else if (/\bpaid\s+staff\b/.test(text) || (/\bpaid\b/.test(text) && !/\bunpaid\b/.test(text))) {
      filters.compensationType = 'paid';
    }
  }

  if (!filters.employmentStatus) {
    if (
      /\b(resigned|retired|former|past employees?|left|ex[\s-]?employees?|ex[\s-]?staff)\b/.test(text)
    ) {
      filters.employmentStatus = 'resigned';
    } else if (
      /\ball (employees?|staff|people)\b/.test(text) ||
      /\bboth (active and resigned|current and resigned)\b/.test(text)
    ) {
      filters.employmentStatus = 'all';
    } else if (
      /\b(currently[- ]?working|on[- ]?roll|on[- ]?the[- ]?rolls?|active employees?|current employees?)\b/.test(
        text
      ) ||
      /\b(active|current)\s+(unpaid|paid|salaried)?\s*(employees?|staff|people)\b/.test(text) ||
      /\b(unpaid|paid|salaried)\s+(active|current)\s+(employees?|staff|people)\b/.test(text)
    ) {
      filters.employmentStatus = 'current';
    } else if (applyStatusDefault && looksLikeEmployeeFilterQuery(userMessage)) {
      // Absence of status filter means ALL — not current. Inferred, not stated:
      // callers with conversation context disable this and inherit instead.
      filters.employmentStatus = 'all';
    }
  }

  return filters;
}

/**
 * @param {string} userMessage
 * @returns {boolean}
 *
 * NOTE: No longer the sole entity gate — resolveEntity() in resolveEntity.js runs first.
 * Used for NL filter parsing defaults and legacy fallback when resolveEntity returns null.
 */
export function looksLikeEmployeeFilterQuery(userMessage) {
  const text = String(userMessage || '').toLowerCase();
  if (!text) return false;

  return (
    /\b(employees?|staff|workforce|team members?|headcount|people)\b/.test(text) ||
    Object.values(EMPLOYEE_FILTER_ALIASES).some((canonicalMap) =>
      Object.values(canonicalMap).some((aliases) =>
        aliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i').test(text))
      )
    )
  );
}
