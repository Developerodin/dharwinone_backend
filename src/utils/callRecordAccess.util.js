/**
 * Field-level access control for call-record payloads.
 *
 * The role matrix has separate "Call Transcripts" and "Call AI Features" toggles,
 * but transcripts and AI extraction data ride inside the call-record documents
 * served under `calls.view`. These helpers strip those field groups from API
 * responses when the requester lacks the matching permission, so the toggles
 * actually govern data access instead of being UI-only.
 */
import { getGrantingPermissions } from '../config/permissions.js';

/** Transcript text fields — gated by the Call Transcripts toggle (call-transcripts.read). */
export const TRANSCRIPT_FIELDS = ['transcript', 'conversationTranscript'];

/** AI extraction/verification fields — gated by the Call AI Features toggle (call-ai.read). */
export const AI_FIELDS = ['extractedData', 'verification', 'callQuality', 'intelligence'];

/**
 * Whether the authenticated request holds `required` (alias-resolved).
 * Mirrors requirePermissions middleware semantics: platformSuperUser bypasses.
 * @param {{ user?: { platformSuperUser?: boolean }, authContext?: { permissions?: Set<string> } }} req
 * @param {string} required
 */
export function authHasPermission(req, required) {
  if (req?.user?.platformSuperUser) return true;
  const permissions = req?.authContext?.permissions;
  if (!permissions || typeof permissions.has !== 'function') return false;
  return getGrantingPermissions(required).some((p) => permissions.has(p));
}

/**
 * Return a copy of a call record with disallowed field groups removed.
 * Never mutates the input. Pass-through for null/undefined.
 * @param {object|null} record - plain object (post-`.lean()`)
 * @param {{ canViewTranscripts?: boolean, canViewAi?: boolean }} access
 */
export function sanitizeCallRecord(record, { canViewTranscripts = false, canViewAi = false } = {}) {
  if (!record || typeof record !== 'object') return record;
  if (canViewTranscripts && canViewAi) return record;
  const out = { ...record };
  if (!canViewTranscripts) for (const f of TRANSCRIPT_FIELDS) delete out[f];
  if (!canViewAi) for (const f of AI_FIELDS) delete out[f];
  return out;
}

/**
 * Sanitize a list of call records with the same access flags.
 * @param {object[]} records
 * @param {{ canViewTranscripts?: boolean, canViewAi?: boolean }} access
 */
export function sanitizeCallRecords(records, access) {
  if (!Array.isArray(records)) return records;
  return records.map((r) => sanitizeCallRecord(r, access));
}
