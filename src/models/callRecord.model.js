import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import { CALL_SOURCES, classifyCallSource } from '../utils/callSource.js';

/**
 * Status state machine. `statusRank` enforces monotonic forward progression so
 * a late "in_progress" poll can never overwrite a "completed" terminal status.
 * Terminal statuses share rank 10 — equal-rank events may still enrich
 * fields (transcript, recording, duration) but cannot change the status text.
 */
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'no_answer',
  'busy',
  'declined',
  'call_disconnected',
  'expired',
];

export const STATUS_RANK = {
  unknown: 0,
  initiated: 1,
  ringing: 2,
  in_progress: 3,
  completed: 10,
  failed: 10,
  no_answer: 10,
  busy: 10,
  declined: 10,
  call_disconnected: 10,
  expired: 10,
};

export function rankOf(status) {
  if (!status) return 0;
  return STATUS_RANK[String(status).toLowerCase()] ?? 0;
}

export function isTerminal(status) {
  if (!status) return false;
  return TERMINAL_STATUSES.includes(String(status).toLowerCase());
}

/**
 * Allowed `source` values. Every CallRecord MUST be tagged with origin so the
 * ghost-cleanup cron can reason about provenance:
 *   - initiate:       seeded by our backend at Bolna POST /call response time
 *   - webhook:        stub-created when Bolna webhook arrived before seed
 *   - reconciliation: stub-created during cron GET /execution/:id reconcile
 *   - backfill:       inserted from agent-list backfill (foreign-call risk)
 *   - legacy:         pre-source-tagging row (treat as untrusted)
 */
export const CALL_RECORD_SOURCES = [
  'initiate',
  'webhook',
  'reconciliation',
  'backfill',
  'legacy',
];

/** Generic CRM call tags an agent can apply (Batch B). Free `purpose` stays for recruitment. */
export const CALL_TAGS = [
  'sales',
  'support',
  'follow_up',
  'complaint',
  'demo',
  'payment',
  'other',
];

/** Entity types a call can be linked to via `relatedTo`. */
export const CALL_RELATED_ENTITY_TYPES = [
  'lead',
  'client',
  'customer',
  'candidate',
  'job',
  'deal',
  'ticket',
  'project',
];

const callRecordSchema = mongoose.Schema(
  {
    /**
     * Bolna execution id. Required — every CallRecord MUST trace to a Bolna
     * execution. Unique index prevents duplicates.
     */
    executionId: {
      type: String,
      required: true,
      index: true,
      unique: true,
    },
    /** Origin of this row. Drives ghost-cleanup decisions. */
    source: {
      type: String,
      enum: CALL_RECORD_SOURCES,
      default: 'legacy',
      index: true,
    },
    /**
     * What KIND of call this is — the classification the UI filters on.
     * Orthogonal to `source` above (that is row provenance) and to
     * telephonyData.provider (the AI agent dials over Twilio too).
     * null = legacy row the classifier could not place; it is deliberately not
     * one of the three UI categories, so such rows show only under "All Calls".
     */
    callSource: {
      type: String,
      enum: [...Object.values(CALL_SOURCES), null],
      default: null,
      index: true,
    },
    /** User who initiated (when source='initiate'). Null for webhook/backfill stubs. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** HTTP request id / correlation id for tracing. */
    requestId: { type: String, default: null },
    /**
     * Set when the cleanup cron has independently confirmed this execution
     * exists in Bolna (GET /execution/:id 200). Stub rows with this null past
     * their grace window are candidates for ghost-cleanup.
     */
    bolnaVerifiedAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      default: 'unknown',
      index: true,
    },
    /** Monotonic guard. Always set together with status. See STATUS_RANK. */
    statusRank: { type: Number, default: 0, index: true },
    statusUpdatedAt: { type: Date, default: Date.now, index: true },
    lastEventId: { type: String, default: null },
    lastEventTs: { type: Date, default: null },
    bolnaUpdatedAt: { type: Date, default: null },

    phone: String,
    recipientPhoneNumber: String,
    toPhoneNumber: { type: String, trim: true },
    userNumber: String,
    fromPhoneNumber: { type: String, trim: true },
    businessName: { type: String, trim: true },
    language: { type: String, trim: true, default: null },
    transcript: String,
    conversationTranscript: String,
    duration: Number,
    recordingUrl: String,
    errorMessage: { type: String, default: null },
    completedAt: { type: Date, default: null },
    extractedData: mongoose.Schema.Types.Mixed,
    /** Typed candidate-verification answers parsed from extractedData. */
    verification: {
      nameConfirmed: { type: Boolean, default: null },
      correctedName: { type: String, default: null },
      jobConfirmed: { type: Boolean, default: null },
      availability: { type: String, default: null },
      currentLocation: { type: String, default: null },
      stillInterested: { type: String, enum: ['interested', 'not_interested', 'withdrew', null], default: null },
      callOutcome: {
        type: String,
        enum: ['fully_confirmed', 'partially_confirmed', 'refused', 'voicemail', 'no_data', null],
        default: null,
      },
      minConfidence: { type: Number, default: null },
      fieldsPresent: { type: Number, default: 0 },
      extractedAt: { type: Date, default: null },
    },
    /**
     * Twilio Conversational Intelligence results for dialer calls. Seeded by the
     * recording webhook (transcriptSid), completed by the Intelligence webhook
     * (summary + transcript text into the top-level `transcript` field).
     */
    intelligence: {
      transcriptSid: { type: String, default: null, index: true },
      status: { type: String, default: null },
      summary: { type: String, default: null },
      requestedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
    },
    /** Derived call-quality flag — stops broken calls masquerading as completed. */
    callQuality: {
      status: { type: String, enum: ['ok', 'needs_review'], default: 'ok' },
      reasons: { type: [String], default: [] },
      evaluatedAt: { type: Date, default: null },
    },
    telephonyData: mongoose.Schema.Types.Mixed,
    /**
     * S3 mirror of the call recordings (Bolna agent leg + Plivo dual-channel),
     * persisted for future review after the provider media expires. Written by
     * callRecordingArchive.service.js. Each source is independent — Plivo's
     * recording can land later than Bolna's.
     */
    recordingArchive: {
      bolna: {
        key: { type: String, default: null },
        bucket: { type: String, default: null },
        size: { type: Number, default: null },
        contentType: { type: String, default: null },
        sourceUrl: { type: String, default: null },
        archivedAt: { type: Date, default: null },
      },
      plivo: {
        key: { type: String, default: null },
        bucket: { type: String, default: null },
        size: { type: Number, default: null },
        contentType: { type: String, default: null },
        sourceUrl: { type: String, default: null },
        archivedAt: { type: Date, default: null },
      },
      // Twilio browser/bridge dialer calls — single dual-channel recording.
      twilio: {
        key: { type: String, default: null },
        bucket: { type: String, default: null },
        size: { type: Number, default: null },
        contentType: { type: String, default: null },
        sourceUrl: { type: String, default: null },
        archivedAt: { type: Date, default: null },
      },
    },
    /** Set once at least one recording source has been mirrored to S3. */
    recordingArchivedAt: { type: Date, default: null },
    purpose: { type: String, trim: true, default: null },
    agentId: { type: String, trim: true, default: null },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    /** Free-text agent notes added during/after the call (Batch B — manual annotation). */
    notes: { type: String, default: '' },
    /** Generic CRM call tags (sales/support/follow-up/etc). Subset of CALL_TAGS. */
    tags: { type: [String], default: [] },
    /**
     * Polymorphic link to the CRM entity this call relates to. One pair instead
     * of six nullable FKs; recruitment `job`/`candidate` refs above stay for the
     * verification flow. entityId is not validated against the target collection.
     */
    relatedTo: {
      entityType: { type: String, enum: [...CALL_RELATED_ENTITY_TYPES, null], default: null },
      entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    raw: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /** Set after post-call thank-you email + in-app notification sent (Bolna webhook idempotency). */
    postCallFollowUpSent: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

/**
 * Classify on insert. Covers every `CallRecord.create(...)` path (Bolna seed,
 * webhook stub, reconciliation, agent-list backfill) from one place. The dialer
 * writes through an aggregation pipeline, which bypasses hooks entirely, so
 * upsertDialerCallRecord calls classifyCallSource itself.
 * Never trusts a client-supplied callSource: the classifier always wins (§15).
 */
callRecordSchema.pre('save', function setCallSource(next) {
  if (this.isNew) this.callSource = classifyCallSource(this.toObject());
  next();
});

callRecordSchema.index({ status: 1, createdAt: -1 });
callRecordSchema.index({ statusRank: 1, statusUpdatedAt: -1 });

callRecordSchema.plugin(toJSON);

const CallRecord = mongoose.model('CallRecord', callRecordSchema);
export default CallRecord;
