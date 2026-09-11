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
 * The same two field groups as they appear on a RAW Bolna execution payload.
 *
 * `GET /executions/{id}` uses snake_case and carries fields our CallRecord does not,
 * so sanitizeCallRecord() alone would strip `transcript` and silently pass
 * `extracted_data`, `summary`, `agent_extraction` and `custom_extractions` straight
 * through. Anything proxying that payload to a client must use these lists instead.
 */
export const BOLNA_TRANSCRIPT_FIELDS = ['transcript', 'transcription', 'conversation_transcript'];
export const BOLNA_AI_FIELDS = [
  'extracted_data',
  'agent_extraction',
  'custom_extractions',
  'summary',
  'tool_call_logs',
];

/**
 * Nested envelopes Bolna wraps the same fields in.
 *
 * Not speculative: normalizePayload() in callRecord.service.js reads the transcript from
 * SIX shapes — `transcript`/`transcription`/`conversation_transcript`, each at the top
 * level and again under `data = payload.data || payload.execution || payload`. Stripping
 * only the flat `transcript` leaves five of the six intact, which is not a sanitiser.
 */
const BOLNA_NESTED_ENVELOPES = ['data', 'execution'];

/**
 * Strip transcript/AI groups from a raw Bolna execution payload.
 * Same access contract as sanitizeCallRecord, different key names.
 *
 * Copies each envelope it edits rather than mutating, so the caller's object — which may
 * be a cached or shared response — is never modified.
 *
 * @param {object|null} details - raw body from GET /executions/{id}
 * @param {{ canViewTranscripts?: boolean, canViewAi?: boolean }} access
 */
export function sanitizeBolnaExecution(details, { canViewTranscripts = false, canViewAi = false } = {}) {
  if (!details || typeof details !== 'object') return details;
  if (canViewTranscripts && canViewAi) return details;

  const strip = (obj) => {
    if (!canViewTranscripts) for (const f of BOLNA_TRANSCRIPT_FIELDS) delete obj[f];
    if (!canViewAi) for (const f of BOLNA_AI_FIELDS) delete obj[f];
  };

  const out = { ...details };
  strip(out);
  for (const nest of BOLNA_NESTED_ENVELOPES) {
    if (out[nest] && typeof out[nest] === 'object' && !Array.isArray(out[nest])) {
      out[nest] = { ...out[nest] };
      strip(out[nest]);
    }
  }
  return out;
}

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
