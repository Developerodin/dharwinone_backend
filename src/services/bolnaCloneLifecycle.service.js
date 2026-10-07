/**
 * Durable lifecycle orchestration for per-call Bolna clone agents.
 *
 * Why this exists:
 * - Webhooks are fast and idempotent, but Bolna execution artifacts (transcript,
 *   extractions, telephony metadata) may land late after terminal events.
 * - Deleting the clone agent immediately on terminal status can destroy the only
 *   forensic trail for disconnected/failed calls.
 *
 * Lifecycle:
 * initiated -> terminal_event_seen -> snapshot_pending -> snapshot_partial
 * -> snapshot_complete|snapshot_exhausted -> cleanup_pending -> cleaned
 *
 * Cleanup is gated:
 * - never before retention window
 * - never before snapshot_complete (default)
 * - snapshot_exhausted deletes only when BOLNA_CLONE_ALLOW_CLEANUP_ON_SNAPSHOT_EXHAUSTED=true
 *   or the row is an orphan failed-initiation (no Bolna execution to snapshot)
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import logger from '../config/logger.js';
import config from '../config/config.js';
import BolnaCloneLifecycle from '../models/bolnaCloneLifecycle.model.js';
import CallRecord, { isTerminal as isTerminalCallStatus } from '../models/callRecord.model.js';
import bolnaService from './bolna.service.js';
import { unregisterOwnedCloneAgent } from './bolnaOwnedAgents.js';
import { isDuplicateKeyError } from '../utils/withAttributionTransaction.js';

const DEFAULTS = {
  retentionHours: 12,
  snapshotMaxAttempts: 8,
  snapshotBackoffBaseSeconds: 30,
  snapshotBackoffMaxSeconds: 1800,
  cleanupMaxAttempts: 8,
  cleanupBackoffBaseSeconds: 120,
  cleanupBackoffMaxSeconds: 7200,
  tickSnapshotBatchSize: 20,
  tickCleanupBatchSize: 20,
  staleRepairBatchSize: 20,
  staleCleanupRetryResetMinutes: 360,
  allowCleanupOnSnapshotExhausted: false,
  workerLeaseSeconds: 120,
};

const EXECUTION_LOGS_POINTER = 'snapshot.executionLogsArchive';
/** Ignore very recent CallRecords so normal seed paths can create lifecycle rows first. */
const REPAIR_MIN_RECORD_AGE_MS = 5 * 60 * 1000;
/** Ceiling for inline gzip archive; larger payloads keep summary only (upgrade path: object storage). */
const MAX_EXECUTION_LOG_ARCHIVE_BYTES = 4 * 1024 * 1024;

const SNAPSHOT_SECTIONS = [
  'core',
  'telephony',
  'transcript',
  'extracted',
  'context',
  'costUsage',
  'agentMetadata',
  'promptSnapshot',
];

const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|auth[_-]?token|api[_-]?key|x-api-key|bearer)/i;

function lifecycleConfig() {
  const cfg = config.bolna?.cloneLifecycle || {};
  return {
    retentionHours: Number(cfg.retentionHours) || DEFAULTS.retentionHours,
    snapshotMaxAttempts: Number(cfg.snapshotMaxAttempts) || DEFAULTS.snapshotMaxAttempts,
    snapshotBackoffBaseSeconds: Number(cfg.snapshotBackoffBaseSeconds) || DEFAULTS.snapshotBackoffBaseSeconds,
    snapshotBackoffMaxSeconds: Number(cfg.snapshotBackoffMaxSeconds) || DEFAULTS.snapshotBackoffMaxSeconds,
    cleanupMaxAttempts: Number(cfg.cleanupMaxAttempts) || DEFAULTS.cleanupMaxAttempts,
    cleanupBackoffBaseSeconds: Number(cfg.cleanupBackoffBaseSeconds) || DEFAULTS.cleanupBackoffBaseSeconds,
    cleanupBackoffMaxSeconds: Number(cfg.cleanupBackoffMaxSeconds) || DEFAULTS.cleanupBackoffMaxSeconds,
    tickSnapshotBatchSize: Number(cfg.tickSnapshotBatchSize) || DEFAULTS.tickSnapshotBatchSize,
    tickCleanupBatchSize: Number(cfg.tickCleanupBatchSize) || DEFAULTS.tickCleanupBatchSize,
    staleRepairBatchSize: Number(cfg.staleRepairBatchSize) || DEFAULTS.staleRepairBatchSize,
    staleCleanupRetryResetMinutes:
      Number(cfg.staleCleanupRetryResetMinutes) || DEFAULTS.staleCleanupRetryResetMinutes,
    allowCleanupOnSnapshotExhausted:
      cfg.allowCleanupOnSnapshotExhausted === true || cfg.allowCleanupOnSnapshotExhausted === 'true',
    workerLeaseSeconds: Number(cfg.workerLeaseSeconds) || DEFAULTS.workerLeaseSeconds,
  };
}

function workerLeaseMs(cfg = lifecycleConfig()) {
  return Math.max(30, Number(cfg.workerLeaseSeconds) || DEFAULTS.workerLeaseSeconds) * 1000;
}

export function isOrphanInitiationLifecycleRow(row) {
  const eid = String(row?.executionId || '').trim();
  if (eid.startsWith('orphan:')) return true;
  const smart = String(row?.terminal?.smartStatus || '').trim();
  if (smart === 'initiate_failed') return true;
  const snapErr = String(row?.snapshot?.lastError || '').trim();
  return snapErr.startsWith('initiate_failed:');
}

export function isCleanupEligibleForSnapshot(row, cfg = lifecycleConfig()) {
  const status = row?.snapshot?.status;
  if (status === 'complete') return true;
  if (status !== 'exhausted') return false;
  if (cfg.allowCleanupOnSnapshotExhausted) return true;
  return isOrphanInitiationLifecycleRow(row);
}

function scheduleCleanupIfEligible(row, reason, now = new Date()) {
  row.cleanup = row.cleanup || {};
  if (row.cleanup.status === 'blocked') {
    return false;
  }
  if (row.snapshot?.status === 'exhausted') {
    setState(row, 'snapshot_exhausted', reason, now);
  }
  if (!isCleanupEligibleForSnapshot(row)) {
    row.cleanup.eligible = false;
    row.cleanup.blockedReason = 'snapshot_exhausted_retention_only';
    row.cleanup.status = 'blocked';
    row.cleanup.nextRetryAt = null;
    return false;
  }
  if (executionLogsBlockCleanup(row)) {
    applyExecutionLogsCleanupGate(row);
    return false;
  }
  row.cleanup.eligible = true;
  row.cleanup.blockedReason = null;
  row.cleanup.status = row.cleanup.status === 'done' ? 'done' : 'pending';
  setState(row, 'cleanup_pending', reason, now);
  row.cleanup.nextRetryAt = row.cleanup.nextRetryAt || row.cleanup.deleteEligibleAt || now;
  return true;
}

export function computeBackoffMs(attempt, baseSeconds, maxSeconds) {
  const n = Math.max(1, Number(attempt) || 1);
  const base = Math.max(1, Number(baseSeconds) || 1);
  const cap = Math.max(base, Number(maxSeconds) || base);
  const seconds = Math.min(cap, base * 2 ** Math.max(0, n - 1));
  return seconds * 1000;
}

function nowPlusMs(ms) {
  return new Date(Date.now() + ms);
}

function nonEmptyString(value) {
  const s = typeof value === 'string' ? value.trim() : String(value || '').trim();
  return s || null;
}

function hasAnyData(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function normalizeDate(raw) {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sanitizeForensicsValue(value, keyHint = '', depth = 0) {
  if (value == null) return value;
  if (SECRET_KEY_PATTERN.test(String(keyHint || ''))) return '[redacted]';
  if (depth > 8) return '[truncated-depth]';

  if (typeof value === 'string') {
    return value.length > 20000 ? `${value.slice(0, 20000)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const arr = value.slice(0, 200).map((entry) => sanitizeForensicsValue(entry, keyHint, depth + 1));
    if (value.length > 200) arr.push(`[truncated:${value.length - 200}]`);
    return arr;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForensicsValue(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

function mergeObjects(base, next) {
  if (!base || typeof base !== 'object') return next;
  if (!next || typeof next !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeObjects(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeExecutionLogs(rawLogs) {
  if (!rawLogs) return null;
  if (Array.isArray(rawLogs)) {
    return {
      type: 'array',
      count: rawLogs.length,
      sampleKeys: rawLogs[0] && typeof rawLogs[0] === 'object' ? Object.keys(rawLogs[0]).slice(0, 20) : [],
    };
  }
  if (typeof rawLogs === 'object') {
    const keys = Object.keys(rawLogs);
    return {
      type: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 40),
    };
  }
  return { type: typeof rawLogs };
}

export function persistExecutionLogsArchive(rawLogs) {
  if (rawLogs == null) return null;
  const sanitized = sanitizeForensicsValue(rawLogs);
  const json = JSON.stringify(sanitized);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
  if (gz.length > MAX_EXECUTION_LOG_ARCHIVE_BYTES) {
    return {
      storage: 'inline',
      compression: 'gzip-base64',
      redacted: true,
      encoding: 'utf8-json',
      truncated: true,
      captureRequired: true,
      captureStatus: 'truncated_requires_manual',
      byteLength: gz.length,
      maxByteLength: MAX_EXECUTION_LOG_ARCHIVE_BYTES,
      itemCount: Array.isArray(sanitized)
        ? sanitized.length
        : typeof sanitized === 'object' && sanitized
          ? Object.keys(sanitized).length
          : 1,
      summary: summarizeExecutionLogs(rawLogs),
      data: null,
    };
  }
  const itemCount = Array.isArray(sanitized)
    ? sanitized.length
    : typeof sanitized === 'object' && sanitized
      ? Object.keys(sanitized).length
      : 1;
  return {
    storage: 'inline',
    compression: 'gzip-base64',
    redacted: true,
    encoding: 'utf8-json',
    captureRequired: true,
    captureStatus: 'captured',
    byteLength: gz.length,
    uncompressedByteLength: Buffer.byteLength(json, 'utf8'),
    itemCount,
    sha256: crypto.createHash('sha256').update(gz).digest('hex'),
    data: gz.toString('base64'),
  };
}

export function decodeExecutionLogsArchive(archive) {
  if (!archive?.data || archive.compression !== 'gzip-base64') return null;
  const buf = zlib.gunzipSync(Buffer.from(String(archive.data), 'base64'));
  return JSON.parse(buf.toString('utf8'));
}

/** True when inline gzip data or an external durable pointer holds the full log payload. */
export function isExecutionLogsDurablyCaptured(archive) {
  if (!archive) return true;
  if (archive.storage && archive.storage !== 'inline') {
    return Boolean(archive.externalRef || archive.uri || archive.pointer);
  }
  if (archive.truncated === true && !archive.data) return false;
  return Boolean(archive.data);
}

export function executionLogsBlockCleanup(row) {
  const archive = row?.snapshot?.executionLogsArchive;
  if (!archive) return false;
  if (archive.captureRequired === false) return false;
  return !isExecutionLogsDurablyCaptured(archive);
}

function applyExecutionLogsCleanupGate(row) {
  if (!executionLogsBlockCleanup(row)) return false;
  row.cleanup = row.cleanup || {};
  row.cleanup.eligible = false;
  row.cleanup.status = 'blocked';
  row.cleanup.blockedReason = 'execution_logs_not_durable';
  row.cleanup.nextRetryAt = null;
  return true;
}

export function attachExecutionLogsToSnapshot(row, rawLogs) {
  if (rawLogs == null) return;
  const archive = persistExecutionLogsArchive(rawLogs);
  if (!archive) return;
  row.snapshot.executionLogsArchive = archive;
  row.snapshot.payload = row.snapshot.payload || {};
  row.snapshot.payload.executionLogs = {
    pointer: EXECUTION_LOGS_POINTER,
    storage: archive.storage,
    compression: archive.compression,
    redacted: archive.redacted,
    byteLength: archive.byteLength,
    uncompressedByteLength: archive.uncompressedByteLength,
    itemCount: archive.itemCount,
    sha256: archive.sha256,
    captureStatus: archive.captureStatus,
    truncated: archive.truncated === true,
    summary: summarizeExecutionLogs(rawLogs),
  };
  if (!isExecutionLogsDurablyCaptured(archive)) {
    applyExecutionLogsCleanupGate(row);
  }
}

function extractAgentMetadata(details = {}, fetchedAgent = null) {
  const agentMeta = fetchedAgent && fetchedAgent.success ? fetchedAgent.agent || {} : {};
  return sanitizeForensicsValue({
    agentId: nonEmptyString(details.agent_id || details.agentId || details.execution?.agent_id),
    agentVersionId: nonEmptyString(
      details.agent_version_id ||
        details.version_id ||
        details.execution?.agent_version_id ||
        details.data?.agent_version_id
    ),
    agentName: nonEmptyString(details.agent_name || details.execution?.agent_name || agentMeta.agent_name),
    updatedAt: nonEmptyString(details.updated_at || details.execution?.updated_at || details.data?.updated_at),
    fetchedAgentConfig: agentMeta && Object.keys(agentMeta).length ? agentMeta : null,
  });
}

function extractCostUsage(details = {}) {
  const cost = {
    total: details.cost ?? details.call_cost ?? details.total_cost ?? null,
    llm: details.llm_cost ?? null,
    stt: details.stt_cost ?? details.asr_cost ?? null,
    tts: details.tts_cost ?? null,
    telephony: details.telephony_cost ?? null,
    currency: details.currency ?? null,
  };
  const usage = details.usage ?? details.usage_breakdown ?? details.token_usage ?? null;
  return sanitizeForensicsValue({ cost, usage });
}

function buildSnapshotPayload(lifecycleRow, details = {}, fetchedAgent = null) {
  const telephonyData = details.telephony_data || details.data?.telephony_data || {};
  const contextDetails = details.context_details || details.data?.context_details || {};
  const transcript =
    details.transcript || details.transcription || details.conversation_transcript || details.data?.transcript || null;
  const summary = details.summary || details.call_summary || details.data?.summary || null;
  const extractedData = details.extracted_data || details.data?.extracted_data || null;
  const customExtractions = details.custom_extractions || details.data?.custom_extractions || null;
  const agentExtraction = details.agent_extraction || details.data?.agent_extraction || null;

  return sanitizeForensicsValue({
    callCore: {
      callId: nonEmptyString(details.call_id || details.id || details.execution_id || lifecycleRow.executionId),
      executionId: lifecycleRow.executionId,
      cloneAgentId: lifecycleRow.cloneAgentId,
      cloneAgentVersionId: nonEmptyString(
        details.agent_version_id || details.version_id || lifecycleRow.cloneAgentVersionId
      ),
      status: nonEmptyString(details.status),
      smartStatus: nonEmptyString(details.smart_status),
      errorMessage: nonEmptyString(details.error_message || details.data?.error_message),
      createdAt: nonEmptyString(details.created_at || details.initiated_at || details.data?.created_at),
      updatedAt: nonEmptyString(details.updated_at || details.data?.updated_at),
      duration: details.duration ?? details.conversation_time ?? null,
    },
    transcript: {
      transcript,
      summary,
      conversationTranscript: details.conversation_transcript || details.data?.conversation_transcript || null,
    },
    extracted: {
      extractedData,
      customExtractions,
      agentExtraction,
    },
    telephony: {
      recordingUrl:
        telephonyData.recording_url ||
        details.recording_url ||
        details.data?.recording_url ||
        lifecycleRow.snapshot?.payload?.telephony?.recordingUrl ||
        null,
      providerCallId: telephonyData.provider_call_id || telephonyData.call_id || null,
      providerConversationId: telephonyData.provider_conversation_id || null,
      data: telephonyData,
    },
    context: {
      contextDetails,
      recipientData: contextDetails?.recipient_data || null,
    },
    costUsage: extractCostUsage(details),
    agentMetadata: extractAgentMetadata(details, fetchedAgent),
    promptSnapshot: {
      renderToken: lifecycleRow.prompt?.renderToken || null,
      hash: lifecycleRow.prompt?.hash || null,
      question1: lifecycleRow.prompt?.question1 || null,
      text:
        lifecycleRow.prompt?.text ||
        details.agent_prompt ||
        details.prompt ||
        details.execution?.agent_prompt ||
        null,
      requestSnapshot: lifecycleRow.prompt?.requestSnapshot || null,
    },
    rawExecution: {
      id: nonEmptyString(details.id || details.execution_id),
      updatedAt: nonEmptyString(details.updated_at),
      status: nonEmptyString(details.status || details.smart_status),
    },
  });
}

export function deriveSnapshotCompleteness(payload = {}) {
  const core = hasAnyData(payload.callCore?.callId) && hasAnyData(payload.callCore?.status);
  const telephony =
    hasAnyData(payload.telephony?.recordingUrl) ||
    hasAnyData(payload.telephony?.providerCallId) ||
    hasAnyData(payload.telephony?.data);
  const transcript = hasAnyData(payload.transcript?.transcript) || hasAnyData(payload.transcript?.summary);
  const extracted =
    hasAnyData(payload.extracted?.extractedData) ||
    hasAnyData(payload.extracted?.customExtractions) ||
    hasAnyData(payload.extracted?.agentExtraction);
  const context = hasAnyData(payload.context?.recipientData) || hasAnyData(payload.context?.contextDetails);
  const costUsage =
    hasAnyData(payload.costUsage?.cost?.total) ||
    hasAnyData(payload.costUsage?.usage) ||
    hasAnyData(payload.costUsage?.cost?.llm) ||
    hasAnyData(payload.costUsage?.cost?.telephony);
  const agentMetadata = hasAnyData(payload.agentMetadata?.agentId) && hasAnyData(payload.agentMetadata?.agentVersionId);
  const promptSnapshot =
    hasAnyData(payload.promptSnapshot?.hash) ||
    hasAnyData(payload.promptSnapshot?.text) ||
    hasAnyData(payload.promptSnapshot?.requestSnapshot);
  return {
    core,
    telephony,
    transcript,
    extracted,
    context,
    costUsage,
    agentMetadata,
    promptSnapshot,
  };
}

function listMissingSections(completeness) {
  return SNAPSHOT_SECTIONS.filter((key) => completeness?.[key] !== true);
}

function isSnapshotComplete(completeness) {
  return listMissingSections(completeness).length === 0;
}

function isTemplateAgent(agentId) {
  const templates = new Set((config.bolna?.allAgentIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  return templates.has(String(agentId || '').trim());
}

function setState(row, nextState, reason, now = new Date()) {
  const prev = row.state;
  if (prev === nextState) return false;
  row.state = nextState;
  row.audit = row.audit || {};
  row.audit.lastTransitionAt = now;
  row.audit.transitionReason = reason || null;
  logger.info('[bolnaCloneLifecycle] state transition', {
    executionId: row.executionId,
    cloneAgentId: row.cloneAgentId,
    from: prev,
    to: nextState,
    reason: reason || 'unknown',
  });
  return true;
}

function applyTerminalMarker(row, terminal, reason = 'terminal_event_seen') {
  const now = normalizeDate(terminal?.eventTs) || new Date();
  row.terminal = row.terminal || {};
  row.terminal.seenAt = now;
  row.terminal.eventId = terminal?.eventId || row.terminal.eventId || null;
  row.terminal.status = nonEmptyString(terminal?.status) || row.terminal.status || null;
  row.terminal.smartStatus = nonEmptyString(terminal?.smartStatus) || row.terminal.smartStatus || null;
  row.terminal.errorMessage = nonEmptyString(terminal?.errorMessage) || row.terminal.errorMessage || null;

  if (row.state === 'cleaned') return false;
  row.snapshot = row.snapshot || {};
  row.cleanup = row.cleanup || {};
  const cleanupBlocked = row.cleanup.status === 'blocked';
  if (!cleanupBlocked) {
    if (row.snapshot.status === 'complete' || row.snapshot.status === 'exhausted') {
      scheduleCleanupIfEligible(row, reason, now);
    } else {
      setState(row, 'terminal_event_seen', reason, now);
      setState(row, 'snapshot_pending', `${reason}:snapshot`, now);
      row.snapshot.status = row.snapshot.status === 'partial' ? 'partial' : 'pending';
      row.snapshot.nextRetryAt = now;
    }
    if (row.cleanup.status !== 'done') {
      row.cleanup.status = 'pending';
      row.cleanup.nextRetryAt = row.cleanup.nextRetryAt || row.cleanup.deleteEligibleAt || now;
    }
  }
  return true;
}

function createBaseLifecycleDoc(seed = {}) {
  const cfg = lifecycleConfig();
  const now = new Date();
  const retentionMs = Math.max(1, cfg.retentionHours) * 60 * 60 * 1000;
  return new BolnaCloneLifecycle({
    executionId: String(seed.executionId || '').trim(),
    cloneAgentId: String(seed.cloneAgentId || '').trim(),
    cloneAgentVersionId: nonEmptyString(seed.cloneAgentVersionId),
    callRecordId: seed.callRecordId || null,
    correlationKey: `${String(seed.executionId || '').trim()}:${String(seed.cloneAgentId || '').trim()}`,
    state: 'initiated',
    snapshot: {
      status: 'pending',
      attempts: 0,
      maxAttempts: cfg.snapshotMaxAttempts,
      nextRetryAt: null,
      completeness: {},
      missingSections: [...SNAPSHOT_SECTIONS],
      payload: {},
    },
    cleanup: {
      status: 'pending',
      attempts: 0,
      maxAttempts: cfg.cleanupMaxAttempts,
      nextRetryAt: null,
      deleteEligibleAt: seed.deleteEligibleAt || new Date(now.getTime() + retentionMs),
    },
    prompt: {
      renderToken: nonEmptyString(seed.promptRenderToken),
      hash: nonEmptyString(seed.promptHash),
      question1: nonEmptyString(seed.question1),
      text: nonEmptyString(seed.promptTextSnapshot),
      requestSnapshot: sanitizeForensicsValue(seed.cloneRequestSnapshot || null),
    },
  });
}

async function findOrCreateLifecycleRowByExecutionId(seed = {}) {
  const executionId = String(seed.executionId || '').trim();
  if (!executionId) return null;

  let row = await BolnaCloneLifecycle.findOne({ executionId });
  if (row) return row;

  row = createBaseLifecycleDoc(seed);
  try {
    await row.save();
    return row;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    row = await BolnaCloneLifecycle.findOne({ executionId });
    if (!row) throw err;
    return row;
  }
}

export async function upsertCloneLifecycleFromSeed(seed = {}) {
  const executionId = String(seed.executionId || '').trim();
  const cloneAgentId = String(seed.cloneAgentId || seed.agentId || '').trim();
  if (!executionId || !cloneAgentId) return null;

  const cfg = lifecycleConfig();
  const now = new Date();
  const retentionMs = Math.max(1, cfg.retentionHours) * 60 * 60 * 1000;
  const row = await findOrCreateLifecycleRowByExecutionId({
    executionId,
    cloneAgentId,
    cloneAgentVersionId: seed.cloneAgentVersionId || seed.agentVersionId,
    callRecordId: seed.callRecordId || null,
    deleteEligibleAt: seed.deleteEligibleAt || new Date(now.getTime() + retentionMs),
    promptRenderToken: seed.promptRenderToken,
    promptHash: seed.promptHash,
    question1: seed.question1,
    promptTextSnapshot: seed.promptTextSnapshot,
    cloneRequestSnapshot: seed.cloneRequestSnapshot,
  });
  if (!row) return null;

  row.cloneAgentId = cloneAgentId;
  row.correlationKey = `${executionId}:${cloneAgentId}`;
  if (!row.cloneAgentVersionId && (seed.cloneAgentVersionId || seed.agentVersionId)) {
    row.cloneAgentVersionId = String(seed.cloneAgentVersionId || seed.agentVersionId);
  }
  if (!row.callRecordId && seed.callRecordId) row.callRecordId = seed.callRecordId;
  if (!row.cleanup?.deleteEligibleAt) row.cleanup.deleteEligibleAt = new Date(now.getTime() + retentionMs);
  row.snapshot.maxAttempts = row.snapshot.maxAttempts || cfg.snapshotMaxAttempts;
  row.cleanup.maxAttempts = row.cleanup.maxAttempts || cfg.cleanupMaxAttempts;

  if (!row.prompt?.renderToken && seed.promptRenderToken) row.prompt.renderToken = String(seed.promptRenderToken);
  if (!row.prompt?.hash && seed.promptHash) row.prompt.hash = String(seed.promptHash);
  if (!row.prompt?.question1 && seed.question1) row.prompt.question1 = String(seed.question1);
  if (!row.prompt?.text && seed.promptTextSnapshot) row.prompt.text = String(seed.promptTextSnapshot);
  if (!row.prompt?.requestSnapshot && seed.cloneRequestSnapshot) {
    row.prompt.requestSnapshot = sanitizeForensicsValue(seed.cloneRequestSnapshot);
  }

  if (isTerminalCallStatus(seed.currentStatus)) {
    applyTerminalMarker(
      row,
      {
        status: seed.currentStatus,
        smartStatus: seed.currentSmartStatus,
        errorMessage: seed.currentErrorMessage,
        eventTs: seed.statusUpdatedAt || now,
        eventId: seed.eventId || `seed-terminal:${executionId}`,
      },
      'seed_terminal'
    );
  }

  await row.save();
  return row.toObject();
}

export async function registerFailedCloneInitiation({
  cloneAgentId,
  cloneAgentVersionId = null,
  errorMessage = null,
  promptRenderToken = null,
  promptHash = null,
  question1 = null,
  promptTextSnapshot = null,
  cloneRequestSnapshot = null,
} = {}) {
  const aid = String(cloneAgentId || '').trim();
  if (!aid) return null;
  const syntheticExecutionId = `orphan:${aid}:${Date.now()}`;
  const now = new Date();
  const row = createBaseLifecycleDoc({
    executionId: syntheticExecutionId,
    cloneAgentId: aid,
    cloneAgentVersionId,
    promptRenderToken,
    promptHash,
    question1,
    promptTextSnapshot,
    cloneRequestSnapshot,
  });
  row.terminal = {
    seenAt: now,
    eventId: `initiate_failed:${syntheticExecutionId}`,
    status: 'failed',
    smartStatus: 'initiate_failed',
    errorMessage: nonEmptyString(errorMessage),
  };
  row.snapshot.status = 'exhausted';
  row.snapshot.attempts = row.snapshot.maxAttempts;
  row.snapshot.lastAttemptAt = now;
  row.snapshot.lastError = `initiate_failed:${nonEmptyString(errorMessage) || 'unknown_error'}`;
  row.snapshot.missingSections = [...SNAPSHOT_SECTIONS];
  setState(row, 'snapshot_exhausted', 'initiate_failed_snapshot_exhausted', now);
  scheduleCleanupIfEligible(row, 'initiate_failed_cleanup_pending', now);
  await row.save();
  return row.toObject();
}

export async function markCloneTerminalEvent({
  executionId,
  cloneAgentId,
  cloneAgentVersionId,
  callRecordId,
  status,
  smartStatus,
  errorMessage,
  eventId,
  eventTs,
} = {}) {
  const eid = String(executionId || '').trim();
  const aid = String(cloneAgentId || '').trim();
  if (!eid || !aid) return null;
  if (!isTerminalCallStatus(status)) return null;

  const row = await findOrCreateLifecycleRowByExecutionId({
    executionId: eid,
    cloneAgentId: aid,
    cloneAgentVersionId,
    callRecordId,
  });
  if (!row) return null;

  if (row.state === 'cleaned') return row.toObject();
  if (!row.callRecordId && callRecordId) row.callRecordId = callRecordId;
  if (!row.cloneAgentVersionId && cloneAgentVersionId) row.cloneAgentVersionId = String(cloneAgentVersionId);
  if (eventId && row.terminal?.eventId === eventId && row.state !== 'initiated') return row.toObject();

  applyTerminalMarker(
    row,
    { status, smartStatus, errorMessage, eventId, eventTs },
    'terminal_event'
  );
  await row.save();
  return row.toObject();
}

async function snapshotAttempt(row, now) {
  const cfg = lifecycleConfig();
  row.snapshot.attempts = Number(row.snapshot.attempts || 0) + 1;
  row.snapshot.lastAttemptAt = now;

  const result = await bolnaService.getExecutionFull(row.executionId);
  if (!result.success || !result.details) {
    row.snapshot.lastError = String(result.error || (result.notFound ? 'execution_not_found' : 'execution_fetch_failed'));
    if (row.snapshot.attempts >= row.snapshot.maxAttempts) {
      row.snapshot.status = 'exhausted';
      scheduleCleanupIfEligible(row, 'snapshot_exhausted_cleanup', now);
    } else {
      row.snapshot.status = 'partial';
      setState(row, 'snapshot_partial', 'snapshot_fetch_retry', now);
      const backoffMs = computeBackoffMs(
        row.snapshot.attempts,
        cfg.snapshotBackoffBaseSeconds,
        cfg.snapshotBackoffMaxSeconds
      );
      row.snapshot.nextRetryAt = nowPlusMs(backoffMs);
    }
    await row.save();
    return { status: 'error' };
  }

  const shouldFetchAgent =
    !hasAnyData(row.snapshot?.payload?.agentMetadata?.fetchedAgentConfig) && !!row.cloneAgentId;
  const fetchedAgent = shouldFetchAgent ? await bolnaService.getAgent(row.cloneAgentId) : null;
  const details = result.details || {};
  const rawLogs = details.execution_logs || details.logs || details.raw_logs || details.events || null;
  attachExecutionLogsToSnapshot(row, rawLogs);
  const incoming = buildSnapshotPayload(row, details, fetchedAgent);
  row.snapshot.payload = mergeObjects(row.snapshot.payload || {}, incoming);
  row.snapshot.completeness = deriveSnapshotCompleteness(row.snapshot.payload);
  row.snapshot.missingSections = listMissingSections(row.snapshot.completeness);
  row.snapshot.lastSuccessAt = now;
  row.snapshot.lastError = null;

  if (isSnapshotComplete(row.snapshot.completeness)) {
    row.snapshot.status = 'complete';
    row.snapshot.nextRetryAt = null;
    setState(row, 'snapshot_complete', 'snapshot_complete', now);
    if (executionLogsBlockCleanup(row)) {
      applyExecutionLogsCleanupGate(row);
    } else {
      scheduleCleanupIfEligible(row, 'snapshot_complete_cleanup', now);
    }
  } else if (row.snapshot.attempts >= row.snapshot.maxAttempts) {
    row.snapshot.status = 'exhausted';
    scheduleCleanupIfEligible(row, 'snapshot_exhausted_cleanup', now);
  } else {
    row.snapshot.status = 'partial';
    const backoffMs = computeBackoffMs(
      row.snapshot.attempts,
      cfg.snapshotBackoffBaseSeconds,
      cfg.snapshotBackoffMaxSeconds
    );
    row.snapshot.nextRetryAt = nowPlusMs(backoffMs);
    setState(row, 'snapshot_partial', 'snapshot_partial_retry', now);
  }

  await row.save();
  return { status: row.snapshot.status };
}

export function canAttemptCleanup(row, now = new Date()) {
  if (!row) return false;
  if (row.state === 'cleaned') return false;
  if (row.cleanup?.eligible === false || row.cleanup?.status === 'blocked') return false;
  const maxAttempts = Number(row.cleanup?.maxAttempts) || lifecycleConfig().cleanupMaxAttempts;
  if (Number(row.cleanup?.attempts || 0) >= maxAttempts) return false;
  if (!row.cleanup?.deleteEligibleAt || new Date(row.cleanup.deleteEligibleAt).getTime() > now.getTime()) return false;
  if (row.cleanup?.nextRetryAt && new Date(row.cleanup.nextRetryAt).getTime() > now.getTime()) return false;
  if (!isCleanupEligibleForSnapshot(row)) return false;
  if (executionLogsBlockCleanup(row)) return false;
  return true;
}

function markCleanupAttemptsExhausted(row, now) {
  row.cleanup.status = 'blocked';
  row.cleanup.eligible = false;
  row.cleanup.blockedReason = 'cleanup_attempts_exhausted';
  row.cleanup.nextRetryAt = null;
  row.cleanup.lastError = row.cleanup.lastError || 'cleanup_attempts_exhausted';
  setState(row, 'cleanup_pending', 'cleanup_attempts_exhausted', now);
}

async function cleanupAttempt(row, now) {
  const cfg = lifecycleConfig();
  if (!canAttemptCleanup(row, now)) return { status: 'skipped' };

  row.cleanup.attempts = Number(row.cleanup.attempts || 0) + 1;
  row.cleanup.lastAttemptAt = now;

  if (!row.cloneAgentId || isTemplateAgent(row.cloneAgentId)) {
    row.cleanup.status = 'done';
    row.cleanup.deletedAt = now;
    row.cleanup.lastError = row.cloneAgentId
      ? 'cleanup skipped: template/shared agent id'
      : 'cleanup skipped: missing clone agent id';
    setState(row, 'cleaned', 'cleanup_skipped_not_deletable', now);
    await row.save();
    return { status: 'skipped_not_deletable' };
  }

  const deleted = await bolnaService.deleteAgent(row.cloneAgentId);
  if (deleted?.success) {
    row.cleanup.status = 'done';
    row.cleanup.deletedAt = now;
    row.cleanup.lastError = deleted.notFound ? 'already_deleted_upstream' : null;
    row.cleanup.nextRetryAt = null;
    unregisterOwnedCloneAgent(row.cloneAgentId);
    setState(row, 'cleaned', deleted.notFound ? 'cleanup_already_deleted' : 'cleanup_deleted', now);
    await row.save();
    return { status: deleted.notFound ? 'already_deleted' : 'deleted' };
  }

  row.cleanup.lastError = String(deleted?.error || 'delete_failed');
  if (row.cleanup.attempts >= row.cleanup.maxAttempts) {
    markCleanupAttemptsExhausted(row, now);
    await row.save();
    return { status: 'exhausted' };
  }
  row.cleanup.status = 'retrying';
  const backoffMs = computeBackoffMs(
    row.cleanup.attempts,
    cfg.cleanupBackoffBaseSeconds,
    cfg.cleanupBackoffMaxSeconds
  );
  row.cleanup.nextRetryAt = nowPlusMs(backoffMs);
  setState(row, 'cleanup_pending', 'cleanup_retry', now);
  await row.save();
  return { status: 'retry' };
}

function leaseAvailableFilter(now) {
  return {
    $or: [{ 'workerLease.holder': null }, { 'workerLease.holder': { $exists: false } }, { 'workerLease.expiresAt': { $lte: now } }],
  };
}

async function releaseWorkerLease(rowId, holder) {
  if (!rowId || !holder) return;
  await BolnaCloneLifecycle.updateOne(
    { _id: rowId, 'workerLease.holder': holder },
    { $unset: { workerLease: '' } }
  );
}

async function claimSnapshotRow(now, holder, leaseExpiresAt) {
  return BolnaCloneLifecycle.findOneAndUpdate(
    {
      state: { $in: ['terminal_event_seen', 'snapshot_pending', 'snapshot_partial'] },
      $and: [
        { $or: [{ 'snapshot.nextRetryAt': null }, { 'snapshot.nextRetryAt': { $lte: now } }] },
        { $expr: { $lt: ['$snapshot.attempts', '$snapshot.maxAttempts'] } },
        leaseAvailableFilter(now),
      ],
    },
    {
      $set: {
        workerLease: { holder, expiresAt: leaseExpiresAt, phase: 'snapshot' },
      },
    },
    { sort: { 'snapshot.nextRetryAt': 1, updatedAt: 1 }, new: true }
  );
}

async function claimCleanupRow(now, holder, leaseExpiresAt) {
  return BolnaCloneLifecycle.findOneAndUpdate(
    {
      state: 'cleanup_pending',
      'cleanup.deleteEligibleAt': { $lte: now },
      'cleanup.eligible': { $ne: false },
      'cleanup.status': { $ne: 'blocked' },
      $and: [
        { $or: [{ 'cleanup.nextRetryAt': null }, { 'cleanup.nextRetryAt': { $lte: now } }] },
        { $expr: { $lt: ['$cleanup.attempts', '$cleanup.maxAttempts'] } },
        leaseAvailableFilter(now),
      ],
    },
    {
      $set: {
        workerLease: { holder, expiresAt: leaseExpiresAt, phase: 'cleanup' },
      },
    },
    { sort: { 'cleanup.deleteEligibleAt': 1, updatedAt: 1 }, new: true }
  );
}

async function processDueSnapshots(_now) {
  const cfg = lifecycleConfig();
  const holder = crypto.randomUUID();

  let attempted = 0;
  let completed = 0;
  let exhausted = 0;
  let errors = 0;

  for (let i = 0; i < cfg.tickSnapshotBatchSize; i += 1) {
    const claimNow = new Date();
    const leaseExpiresAt = new Date(claimNow.getTime() + workerLeaseMs(cfg));
    const row = await claimSnapshotRow(claimNow, holder, leaseExpiresAt);
    if (!row) break;
    attempted += 1;
    try {
      const res = await snapshotAttempt(row, claimNow);
      if (res.status === 'complete') completed += 1;
      if (res.status === 'exhausted') exhausted += 1;
      if (res.status === 'error') errors += 1;
    } catch (err) {
      errors += 1;
      logger.warn('[bolnaCloneLifecycle] snapshot attempt failed', {
        executionId: row.executionId,
        cloneAgentId: row.cloneAgentId,
        error: err?.message || String(err),
      });
    } finally {
      await releaseWorkerLease(row._id, holder);
    }
  }
  return { attempted, completed, exhausted, errors };
}

async function processDueCleanup(_now) {
  const cfg = lifecycleConfig();
  const holder = crypto.randomUUID();

  let attempted = 0;
  let cleaned = 0;
  let retried = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < cfg.tickCleanupBatchSize; i += 1) {
    const claimNow = new Date();
    const leaseExpiresAt = new Date(claimNow.getTime() + workerLeaseMs(cfg));
    const row = await claimCleanupRow(claimNow, holder, leaseExpiresAt);
    if (!row) break;
    attempted += 1;
    try {
      const res = await cleanupAttempt(row, claimNow);
      if (res.status === 'deleted' || res.status === 'already_deleted') cleaned += 1;
      else if (res.status === 'retry') retried += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      logger.warn('[bolnaCloneLifecycle] cleanup attempt failed', {
        executionId: row.executionId,
        cloneAgentId: row.cloneAgentId,
        error: err?.message || String(err),
      });
    } finally {
      await releaseWorkerLease(row._id, holder);
    }
  }
  return { attempted, cleaned, retried, skipped, errors };
}

function buildMissingLifecycleRepairPipeline(repairCutoff, batchSize, lifecycleCollectionName) {
  const limit = Math.max(1, Number(batchSize) || DEFAULTS.staleRepairBatchSize);
  return [
    {
      $match: {
        ownedClone: true,
        executionId: { $exists: true, $nin: [null, ''] },
        agentId: { $exists: true, $nin: [null, ''] },
        createdAt: { $lte: repairCutoff },
      },
    },
    {
      $lookup: {
        from: lifecycleCollectionName,
        localField: 'executionId',
        foreignField: 'executionId',
        as: '_lifecycleJoin',
      },
    },
    { $match: { _lifecycleJoin: { $eq: [] } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        executionId: 1,
        agentId: 1,
        status: 1,
        statusUpdatedAt: 1,
        errorMessage: 1,
        promptRenderToken: 1,
        promptHash: 1,
        question1: 1,
      },
    },
  ];
}

async function findCallRecordsMissingLifecycle(now, batchSize) {
  const repairCutoff = new Date(now.getTime() - REPAIR_MIN_RECORD_AGE_MS);
  const pipeline = buildMissingLifecycleRepairPipeline(
    repairCutoff,
    batchSize,
    BolnaCloneLifecycle.collection.name
  );
  return CallRecord.aggregate(pipeline);
}

async function repairMissingLifecycleRows(now) {
  const cfg = lifecycleConfig();
  const records = await findCallRecordsMissingLifecycle(now, cfg.staleRepairBatchSize);

  if (!records.length) return { scanned: 0, inserted: 0 };
  const seen = new Set();
  let inserted = 0;

  for (const rec of records) {
    if (seen.has(rec.executionId)) continue;
    try {
      const created = await upsertCloneLifecycleFromSeed({
        executionId: rec.executionId,
        cloneAgentId: rec.agentId,
        callRecordId: rec._id,
        currentStatus: rec.status,
        currentErrorMessage: rec.errorMessage,
        statusUpdatedAt: rec.statusUpdatedAt || now,
        promptRenderToken: rec.promptRenderToken,
        promptHash: rec.promptHash,
        question1: rec.question1,
      });
      if (created) {
        inserted += 1;
        seen.add(rec.executionId);
      }
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        seen.add(rec.executionId);
        continue;
      }
      logger.warn('[bolnaCloneLifecycle] repair seed failed', {
        executionId: rec.executionId,
        error: err?.message || String(err),
      });
    }
  }
  return { scanned: records.length, inserted };
}

async function finalizeStaleExhaustedCleanupRows(now) {
  const cfg = lifecycleConfig();
  const staleCutoff = new Date(now.getTime() - cfg.staleCleanupRetryResetMinutes * 60 * 1000);
  const rows = await BolnaCloneLifecycle.find({
    state: 'cleanup_pending',
    'cleanup.status': { $in: ['retrying', 'pending'] },
    'cleanup.eligible': { $ne: false },
    $or: [{ 'cleanup.nextRetryAt': { $lte: staleCutoff } }, { 'cleanup.nextRetryAt': null }],
    $expr: { $gte: ['$cleanup.attempts', '$cleanup.maxAttempts'] },
  })
    .limit(cfg.tickCleanupBatchSize)
    .sort({ 'cleanup.nextRetryAt': 1 });

  let blocked = 0;
  for (const row of rows) {
    markCleanupAttemptsExhausted(row, now);
    await row.save();
    blocked += 1;
  }
  return { blocked };
}

export async function runBolnaCloneLifecycleTick() {
  const now = new Date();
  const metrics = {
    repaired: { scanned: 0, inserted: 0 },
    snapshots: { attempted: 0, completed: 0, exhausted: 0, errors: 0 },
    cleanup: { attempted: 0, cleaned: 0, retried: 0, skipped: 0, errors: 0 },
    staleCleanupBlocked: { blocked: 0 },
    skipped: false,
  };

  metrics.repaired = await repairMissingLifecycleRows(now);

  if (!config.bolna?.apiKey) {
    metrics.skipped = true;
    return metrics;
  }

  metrics.snapshots = await processDueSnapshots(now);
  metrics.cleanup = await processDueCleanup(now);
  metrics.staleCleanupBlocked = await finalizeStaleExhaustedCleanupRows(now);
  return metrics;
}

export const __testables = {
  computeBackoffMs,
  deriveSnapshotCompleteness,
  canAttemptCleanup,
  listMissingSections,
  isSnapshotComplete,
  applyTerminalMarker,
  isOrphanInitiationLifecycleRow,
  isCleanupEligibleForSnapshot,
  scheduleCleanupIfEligible,
  persistExecutionLogsArchive,
  decodeExecutionLogsArchive,
  attachExecutionLogsToSnapshot,
  isExecutionLogsDurablyCaptured,
  executionLogsBlockCleanup,
  markCleanupAttemptsExhausted,
  findOrCreateLifecycleRowByExecutionId,
  claimSnapshotRow,
  claimCleanupRow,
  releaseWorkerLease,
  workerLeaseMs,
  buildMissingLifecycleRepairPipeline,
  findCallRecordsMissingLifecycle,
  repairMissingLifecycleRows,
  REPAIR_MIN_RECORD_AGE_MS,
};

export default {
  upsertCloneLifecycleFromSeed,
  registerFailedCloneInitiation,
  markCloneTerminalEvent,
  runBolnaCloneLifecycleTick,
};
