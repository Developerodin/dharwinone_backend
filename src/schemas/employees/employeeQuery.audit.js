import config from '../../config/config.js';
import logger from '../../config/logger.js';

/**
 * Filter keys whose VALUE never reaches the log. `filterKeysUsed` still records
 * that the key was used, which is what keeps a targeted lookup reconstructible.
 *
 * `search` and `fullName` are in here because they are how a targeted lookup is
 * actually spelled: `search: "someone@example.com"` carried the very address that
 * redacting `email` was meant to keep out of the log. The salary and phone keys
 * are not declared in employeeFilter.schema.json and, since T4 removed
 * stripUnknown, can no longer survive validation — they stay as a backstop for
 * any caller that builds an audit entry without going through the validator.
 */
const REDACTED_AUDIT_FILTER_KEYS = new Set([
  'salaryRange',
  'salaryRangeMin',
  'salaryRangeMax',
  'salarySlips',
  'email',
  'phone',
  'search',
  'fullName',
]);

function sanitizeFilters(filters) {
  if (!filters || typeof filters !== 'object') {
    return undefined;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(filters)) {
    if (REDACTED_AUDIT_FILTER_KEYS.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Build a production-safe audit entry for employee entityQuery execution.
 */
export function buildAuditEntry({
  structuredQuery,
  sanitizedQuery,
  mongoFilter,
  requestId,
  userMessage,
  userId,
  adminId,
  uiContextApplied,
  provenance,
  resultCount,
  total,
  executionTimeMs,
  timestamp,
  serviceDefaultsApplied,
  authDecision,
}) {
  const filters = structuredQuery?.filters ?? null;
  const entry = {
    requestId,
    entity: structuredQuery?.entity ?? 'employees',
    operations: structuredQuery?.operations ?? [],
    filterKeysUsed: filters ? Object.keys(filters).sort() : [],
    sanitizedQuery: sanitizedQuery ?? sanitizeFilters(filters),
    userMessageLength: typeof userMessage === 'string' ? userMessage.length : undefined,
    uiContextApplied: Boolean(uiContextApplied),
    authDecision: authDecision ?? 'ALLOWED',
    provenance,
    userId,
    adminId,
    source: 'chatbot',
    resultCount,
    total,
    executionTimeMs,
    timestamp: timestamp ?? new Date().toISOString(),
  };

  if (config.chatbot?.queryAuditDebug) {
    if (structuredQuery) entry.structuredQuery = structuredQuery;
    if (userMessage) entry.userMessage = userMessage;
    if (mongoFilter) entry.mongoFilter = mongoFilter;
    if (serviceDefaultsApplied) entry.serviceDefaultsApplied = serviceDefaultsApplied;
  }

  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

/**
 * Log sanitized employee query audit entry. Uses requestId from controller (req.id).
 */
export function logEmployeeQueryAudit(payload, { requestId } = {}) {
  const entry = buildAuditEntry({
    ...payload,
    requestId: requestId ?? payload.requestId,
  });
  logger.info('[employeeQuery.audit] %s', JSON.stringify(entry));
  return entry;
}
