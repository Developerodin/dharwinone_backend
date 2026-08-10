import config from '../../config/config.js';
import logger from '../../config/logger.js';

const REDACTED_AUDIT_FILTER_KEYS = new Set([
  'salaryRange',
  'salaryRangeMin',
  'salaryRangeMax',
  'salarySlips',
  'email',
  'phone',
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
