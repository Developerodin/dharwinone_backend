import { parseAuditSource } from '../constants/auditSource.js';

/**
 * @typedef {Object} AtsAuditEnvelope
 * @property {{ action: string, entityType: string, entityId: string, metadata?: object, occurredAt?: Date|string|null, skipReason?: string }|null} audit
 */

/**
 * @template T
 * @param {T} result
 * @param {{ action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>, occurredAt?: Date|string|null, skipReason?: string }|null} audit
 * @returns {{ result: T, audit: typeof audit }}
 */
export const buildAtsAuditEnvelope = (result, audit) => ({ result, audit });

/**
 * Normalize buildFieldChangeLog object or pre-built array into metadata.changes[].
 * @param {Record<string, unknown>|Array<{ field: string, from?: unknown, to?: unknown, changed?: boolean }>|null|undefined} changes
 * @returns {Array<{ field: string, from?: unknown, to?: unknown, changed?: boolean }>}
 */
export const normalizeChangesArray = (changes) => {
  if (!changes) return [];
  if (Array.isArray(changes)) return changes;
  return Object.entries(changes).map(([field, val]) => {
    if (val === '[changed]') return { field, changed: true };
    if (val && typeof val === 'object' && ('from' in val || 'to' in val)) {
      return { field, from: val.from, to: val.to };
    }
    return { field, changed: true };
  });
};

/**
 * Edit context — mutually exclusive selfService vs staffEdit.
 * @param {{ selfService?: boolean, staffEdit?: boolean }} ctx
 * @returns {{ selfService?: true, staffEdit?: true }}
 */
export const applyEditContext = (ctx = {}) => {
  if (ctx.selfService) return { selfService: true };
  if (ctx.staffEdit === false) return {};
  return { staffEdit: true };
};

/**
 * @param {import('express').Request|null} req
 * @returns {string|null}
 */
export const resolveCorrelationId = (req) => {
  if (req?.id) return String(req.id);
  const hdr = req?.headers?.['x-request-id'];
  return hdr ? String(hdr) : null;
};

/**
 * Base metadata merged into every ATS audit row.
 * @param {import('express').Request|null} req
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
export const buildAtsMetadataBase = (req, extra = {}) => {
  const source = parseAuditSource(req);
  const requestId = resolveCorrelationId(req);
  const out = { ...extra, auditSource: source };
  if (source !== 'system') out.source = source;
  if (requestId) out.requestId = requestId;
  return out;
};

/**
 * Merge edit context and normalized changes into audit metadata.
 * @param {Record<string, unknown>} metadata
 * @param {{ selfService?: boolean, staffEdit?: boolean, changes?: Record<string, unknown>|Array }} opts
 */
export const enrichAtsMetadata = (metadata = {}, opts = {}) => {
  const out = { ...metadata, ...applyEditContext(opts) };
  if (opts.changes) {
    const arr = normalizeChangesArray(opts.changes);
    if (arr.length) out.changes = arr;
  }
  return out;
};
