import logger from '../config/logger.js';

/** Allowed values for the x-audit-source request header (frontend screen context). */
export const AUDIT_SOURCE_ALLOWLIST = new Set([
  'ats-web',
  'ats-api',
  'ats-worker',
  'system',
]);

export const DEFAULT_AUDIT_SOURCE = 'system';

const MAX_SOURCE_LEN = 120;

/**
 * Parse and validate x-audit-source. Invalid or missing values fall back to 'system' (warn only).
 * @param {import('express').Request|null} req
 * @returns {string}
 */
export const parseAuditSource = (req) => {
  const raw = req?.get?.('x-audit-source') ?? req?.headers?.['x-audit-source'];
  if (raw == null || raw === '') return DEFAULT_AUDIT_SOURCE;
  const val = String(raw).trim().slice(0, MAX_SOURCE_LEN);
  if (!val) return DEFAULT_AUDIT_SOURCE;
  const lower = val.toLowerCase();
  if (!AUDIT_SOURCE_ALLOWLIST.has(lower)) {
    // Allow structured screen paths: ats/employees/edit, ats/interviews/CreateInterviewModal
    if (!lower.startsWith('ats/')) {
      logger.warn({ auditSource: val }, 'ats_audit_invalid_source_fallback_system');
      return DEFAULT_AUDIT_SOURCE;
    }
  }
  return lower;
};
