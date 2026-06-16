/**
 * Single chokepoint for every Bolna-derived state change.
 *
 * Why this exists:
 *   - Webhook + reconciliation cron + manual sync all used to write CallRecord
 *     directly with their own ad-hoc field-merge logic. That race let late polls
 *     overwrite terminal status, dropped fields, and produced duplicate rows when
 *     the Bolna webhook beat the initiate-time seed insert.
 *
 * Guarantees:
 *   1. Idempotent on `eventId` via the CallEvent unique index — webhook retries
 *      and reconciliation polls cost zero writes once seen.
 *   2. Monotonic on `statusRank` — terminal statuses cannot be regressed by
 *      late "in_progress" polls.
 *   3. Single normalization path — businessName / status mapping / payload
 *      flattening lives here only. Other writers must go through this module.
 */

import crypto from 'crypto';
import logger from '../config/logger.js';
import config from '../config/config.js';
import { deriveCallInsights } from '../utils/candidateExtraction.js';
import CallRecord, {
  STATUS_RANK,
  TERMINAL_STATUSES,
  rankOf,
  isTerminal,
} from '../models/callRecord.model.js';
import CallEvent from '../models/callEvent.model.js';
import callRecordService from './callRecord.service.js';

// Lazy import — chatSocket.service.js loads chat.service.js which touches many
// models; deferring the import keeps callSync usable from any layer.
let _emitCallUpdate = null;
async function emitUpdate(record) {
  try {
    if (!_emitCallUpdate) {
      const mod = await import('./chatSocket.service.js');
      _emitCallUpdate = mod.emitCallUpdate || (() => {});
    }
    _emitCallUpdate(record);
  } catch (err) {
    logger.warn(`[callSync] emit failed: ${err.message}`);
  }
}

const STATUS_MAP = {
  done: 'completed',
  finished: 'completed',
  ended: 'completed',
  success: 'completed',
  error: 'failed',
  errored: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  stopped: 'failed',
  initiate: 'initiated',
  initiated: 'initiated',
  queued: 'initiated',
  'no-answer': 'no_answer',
  'call-disconnected': 'call_disconnected',
  'in-progress': 'in_progress',
  ringing: 'ringing',
  'balance-low': 'failed',
};

function normalizeStatus(s) {
  if (!s) return 'unknown';
  const k = String(s).toLowerCase().trim();
  return STATUS_MAP[k] || k;
}

/**
 * Stable id for a Bolna event so retries fold to the same CallEvent row.
 *   1. payload.event_id  — explicit when Bolna sends one
 *   2. payload.id + ts   — list-API derived, unique per state snapshot
 *   3. SHA-256 fallback  — for partial bodies
 */
function deriveEventId(payload, executionId) {
  if (payload.event_id) return String(payload.event_id);
  const ts = payload.updated_at || payload.timestamp || payload.data?.updated_at;
  if (payload.id && ts) return `${payload.id}:${ts}`;
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      `${executionId}|${payload.status || payload.smart_status || ''}|${ts || ''}|${
        payload.duration ?? payload.data?.duration ?? ''
      }`
    )
    .digest('hex')
    .slice(0, 32);
  return `${executionId}:${fingerprint}`;
}

function eventTimestamp(payload) {
  const raw =
    payload.updated_at ||
    payload.timestamp ||
    payload.data?.updated_at ||
    payload.initiated_at ||
    payload.data?.initiated_at;
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Verify Bolna webhook secret (header). Mirrors verifyBolnaWebhook middleware. */
export function verifyBolnaSecret(headerSecret) {
  const expected = (config.webhooks?.bolnaSecret || '').trim();
  if (!expected) return true;
  if (!headerSecret) return false;
  try {
    const a = Buffer.from(String(headerSecret), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Map applyEvent source values to the canonical `source` enum stored on
 * CallRecord. Webhook + webhook_candidate collapse to 'webhook' since they
 * differ only in agent identity, not provenance.
 */
function canonicalSource(source) {
  if (source === 'webhook' || source === 'webhook_candidate') return 'webhook';
  if (source === 'reconciliation') return 'reconciliation';
  if (source === 'backfill') return 'backfill';
  if (source === 'initiate') return 'initiate';
  return 'legacy';
}

/**
 * Apply a Bolna state change to CallRecord.
 *
 * @param {object} payload Raw Bolna payload (webhook body OR /execution/:id response)
 * @param {'webhook'|'webhook_candidate'|'reconciliation'|'backfill'} source
 * @param {object} [meta]
 * @param {string} [meta.requestId] correlation id for tracing the originating HTTP request
 * @returns {Promise<{ record: object|null, applied: boolean, reason?: string }>}
 */
export async function applyEvent(payload, source, meta = {}) {
  if (!payload || typeof payload !== 'object') {
    return { record: null, applied: false, reason: 'invalid_payload' };
  }

  // Reuse existing normalize (handles flat + nested .data + .execution shapes,
  // resolves to/from phones, businessName from user_data, etc.)
  const norm = callRecordService.normalizePayload(payload);
  const executionId = norm.executionId;
  if (!executionId) {
    logger.warn(`[callSync] event missing executionId source=${source}`);
    return { record: null, applied: false, reason: 'no_execution_id' };
  }

  const status = normalizeStatus(norm.status);
  const incomingRank = rankOf(status);
  const eventTs = eventTimestamp(payload);
  const eventId = deriveEventId(payload, executionId);

  // 1. Idempotency — unique index on eventId fences concurrent processors.
  try {
    await CallEvent.create({
      eventId,
      executionId,
      status,
      eventTs,
      source,
      payload: source === 'webhook' || source === 'webhook_candidate' ? payload : { fromList: source },
    });
  } catch (err) {
    if (err.code === 11000) {
      return { record: null, applied: false, reason: 'duplicate_event' };
    }
    throw err;
  }

  // 2. Build $set. Only Bolna-owned fields. App fields (candidate, job, purpose)
  // are seeded by seedRecord at initiate time — never overwritten here.
  const set = {
    statusUpdatedAt: eventTs,
    lastEventId: eventId,
    lastEventTs: eventTs,
    bolnaUpdatedAt: eventTs,
  };

  if (incomingRank > 0 || status === 'unknown') {
    set.status = status;
    set.statusRank = incomingRank;
  }

  if (norm.duration != null) set.duration = norm.duration;
  if (norm.recordingUrl) set.recordingUrl = norm.recordingUrl;
  if (norm.transcript) set.transcript = norm.transcript;
  if (norm.conversationTranscript) set.conversationTranscript = norm.conversationTranscript;
  if (norm.fromPhoneNumber) {
    set.fromPhoneNumber = norm.fromPhoneNumber;
    if (!norm.userNumber) set.userNumber = norm.fromPhoneNumber;
  }
  if (norm.toPhoneNumber) {
    set.toPhoneNumber = norm.toPhoneNumber;
    set.recipientPhoneNumber = norm.recipientPhoneNumber || norm.toPhoneNumber;
    set.phone = norm.phone || norm.toPhoneNumber;
  }
  if (norm.extractedData) set.extractedData = norm.extractedData;
  if (norm.telephonyData) set.telephonyData = norm.telephonyData;
  if (norm.language) set.language = norm.language;
  // Phase 1: derive typed verification answers + quality flag whenever this event
  // carries an extraction or transcript. extractedAt/evaluatedAt stamped from event ts.
  if (norm.extractedData || norm.transcript) {
    const insights = deriveCallInsights({
      extractedData: norm.extractedData,
      transcript: norm.transcript,
      status,
    });
    set.verification = { ...insights.verification, extractedAt: eventTs };
    set.callQuality = { ...insights.callQuality, evaluatedAt: eventTs };
  }
  if (isTerminal(status)) set.completedAt = eventTs;

  const errMsg =
    payload.error_message ||
    payload.data?.error_message ||
    payload.execution?.error_message;
  if (errMsg) {
    let m = errMsg;
    if (typeof m === 'string') {
      try {
        const parsed = JSON.parse(m);
        if (parsed && parsed.message) m = parsed.message;
      } catch { /* not JSON */ }
    }
    set.errorMessage = String(m).slice(0, 1000);
  }

  // 3. Monotonic update filter:
  //    - lower rank: advance freely
  //    - same rank, newer ts: enrichment / final patch
  //    - same rank terminal: still allow enrichment (transcript may arrive late)
  const filter = {
    executionId,
    $or: [
      { statusRank: { $lt: incomingRank } },
      { statusRank: incomingRank, statusUpdatedAt: { $lte: eventTs } },
      ...(isTerminal(status) ? [{ statusRank: incomingRank }] : []),
    ],
  };

  const record = await CallRecord.findOneAndUpdate(filter, { $set: set }, { new: true }).lean();

  if (record) {
    logger.info(
      `[callSync] applied ${eventId} → ${status} (rank=${incomingRank}, source=${source}) for ${executionId}`
    );
    emitUpdate(record);
    return { record, applied: true };
  }

  // 4. Filter rejected — either record absent or stale event.
  const existing = await CallRecord.findOne({ executionId })
    .select('_id status statusRank statusUpdatedAt')
    .lean();

  if (!existing) {
    // Backfill source = enrich-only. The Bolna agent-list endpoint returns
    // EVERY execution under that agent_id, including foreign/test calls
    // initiated outside this backend, and queued execs with no telephony
    // fields populated yet. Without this guard, those landed as
    // status=unknown rows with no caller/recipient — the exact junk the
    // UI was showing under Telephony source.
    if (source === 'backfill') {
      logger.info(
        `[callSync] backfill skip unseeded executionId=${executionId} status=${status} agentId=${norm.agentId || ''}`
      );
      return { record: null, applied: false, reason: 'unseeded_backfill_skipped' };
    }

    // For webhook + reconciliation we used to stub-create blindly. That was
    // ghost-call vector #1: a replayed Bolna webhook (or one mis-routed from a
    // sibling tenant under the same secret) would persist a row our backend
    // had no provenance over. Now: verify upstream first. If Bolna 404s the
    // executionId, drop the event and log an anomaly. If Bolna is reachable
    // and confirms the execution, stub-create AND tag bolnaVerifiedAt so the
    // ghost-cleanup cron can distinguish verified-but-unseeded rows from
    // truly orphaned ones.
    let bolnaVerifiedAt = null;
    try {
      const bolnaService = (await import('./bolna.service.js')).default;
      const verify = await bolnaService.verifyExecutionExistsInBolna(executionId);
      if (verify.notFound === true) {
        logger.warn(
          `[callSync] anomaly: ${source} for executionId=${executionId} not found in Bolna — dropping`
        );
        return { record: null, applied: false, reason: 'bolna_not_found' };
      }
      if (verify.exists !== true) {
        // Transport / 5xx — DON'T persist on fuzzy signal. Webhook will retry,
        // reconciliation cron will retry. Better silence than ghost.
        logger.warn(
          `[callSync] verify upstream failed source=${source} executionId=${executionId} err=${verify.error || ''} — deferring`
        );
        return { record: null, applied: false, reason: 'bolna_verify_unavailable' };
      }
      bolnaVerifiedAt = new Date();
    } catch (err) {
      logger.warn(
        `[callSync] verify exception source=${source} executionId=${executionId}: ${err.message} — deferring`
      );
      return { record: null, applied: false, reason: 'bolna_verify_exception' };
    }

    // Race-safe via executionId unique index — losing race re-checks.
    try {
      const stub = await CallRecord.create({
        ...set,
        executionId,
        status: status || 'unknown',
        statusRank: incomingRank,
        purpose: norm.purpose || null,
        agentId: norm.agentId || null,
        businessName: norm.businessName || null,
        source: canonicalSource(source),
        createdBy: null,
        requestId: meta.requestId || null,
        bolnaVerifiedAt,
        raw: payload,
      });
      logger.info(
        `[callSync] stub-created for ${executionId} source=${source} bolnaVerified=${Boolean(bolnaVerifiedAt)}`
      );
      const lean = stub.toObject();
      emitUpdate(lean);
      return { record: lean, applied: true, reason: 'stub_created' };
    } catch (err) {
      if (err.code === 11000) {
        const after = await CallRecord.findOne({ executionId }).lean();
        return { record: after, applied: false, reason: 'concurrent_seed' };
      }
      throw err;
    }
  }

  logger.info(
    `[callSync] no-op for ${executionId} eventId=${eventId} ` +
      `(incoming rank=${incomingRank} ts=${eventTs.toISOString()} ` +
      `existing rank=${existing.statusRank} ts=${existing.statusUpdatedAt?.toISOString?.() || ''})`
  );
  return { record: existing, applied: false, reason: 'stale_event' };
}

/**
 * Seed a CallRecord at Bolna initiate time. App-owned fields only.
 * Idempotent: re-running with same executionId leaves Bolna-owned fields untouched.
 *
 * @param {object} args
 * @param {string} args.executionId   Bolna execution id
 * @param {string} [args.candidate]   Employee _id
 * @param {string} [args.job]         Job _id
 * @param {string} [args.purpose]     'job_application_verification' | 'job_posting_verification' | …
 * @param {string} [args.agentId]
 * @param {string} [args.recipientPhone]
 * @param {string} [args.businessName]
 * @returns {Promise<object>} the created or pre-existing CallRecord (lean)
 */
export async function seedRecord({
  executionId,
  candidate,
  job,
  purpose,
  agentId,
  recipientPhone,
  businessName,
  createdBy,
  requestId,
}) {
  if (!executionId) throw new Error('seedRecord: executionId required');

  const onInsert = {
    executionId: String(executionId),
    status: 'initiated',
    statusRank: STATUS_RANK.initiated,
    statusUpdatedAt: new Date(),
    candidate: candidate || null,
    job: job || null,
    purpose: purpose || null,
    agentId: agentId || null,
    recipientPhoneNumber: recipientPhone || null,
    toPhoneNumber: recipientPhone || null,
    phone: recipientPhone || null,
    businessName: businessName || null,
    // Provenance — initiate is the trusted path. Bolna POST /call already
    // returned this executionId so we don't need a second verify hit.
    source: 'initiate',
    createdBy: createdBy || null,
    requestId: requestId || null,
    bolnaVerifiedAt: new Date(),
  };

  // Upsert by executionId, only set on insert. Existing rows untouched.
  const record = await CallRecord.findOneAndUpdate(
    { executionId: onInsert.executionId },
    { $setOnInsert: onInsert },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  // Fill app-owned nulls (case: stub created by webhook-before-seed lacks links)
  const appFields = { candidate, job, purpose, agentId, businessName };
  const patch = {};
  const filter = { executionId: onInsert.executionId };
  for (const [k, v] of Object.entries(appFields)) {
    if (v == null) continue;
    if (record[k] == null || record[k] === '') {
      patch[k] = v;
      filter[k] = { $in: [null, undefined, ''] };
    }
  }
  if (Object.keys(patch).length) {
    await CallRecord.updateOne(filter, { $set: patch }).catch(() => {});
  }

  // Idempotent seed-event log
  await CallEvent.create({
    eventId: `seed:${onInsert.executionId}`,
    executionId: onInsert.executionId,
    status: 'initiated',
    eventTs: new Date(),
    source: 'initiate',
    payload: { seed: true, candidate, job, purpose, agentId },
  }).catch((err) => {
    if (err.code !== 11000) logger.warn(`[callSync] seed event log failed: ${err.message}`);
  });

  emitUpdate(record);
  return record;
}

export { STATUS_RANK, TERMINAL_STATUSES, rankOf, isTerminal, normalizeStatus };

export default {
  applyEvent,
  seedRecord,
  verifyBolnaSecret,
  normalizeStatus,
};
