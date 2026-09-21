import crypto from 'crypto';
import { AgentDispatchClient } from 'livekit-server-sdk';
import config from '../config/config.js';
import logger from '../config/logger.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import { getMeetingByMeetingId } from './meetingLookup.service.js';

const ASSISTANT_AGENT_NAME = 'meeting-assistant-agent';

const livekitUrl = config.livekit?.url?.replace(/^ws/, 'http') || 'http://localhost:7880';
const apiKey = config.livekit?.apiKey;
const apiSecret = config.livekit?.apiSecret;

let dispatchClient = null;
if (apiKey && apiSecret) {
  try {
    dispatchClient = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);
  } catch (err) {
    logger.warn('[AgentDispatch] failed to init client', { error: err.message });
  }
}

export function buildDispatchMetadata({ meetingId, recordingId, hmacToken }) {
  return JSON.stringify({
    meetingId: String(meetingId),
    recordingId: recordingId ? String(recordingId) : null,
    hmacToken: String(hmacToken),
  });
}

export function buildDispatchMetadataV2({ meetingId, recordingId, hmacToken, dispatchKey, language = 'en' }) {
  return JSON.stringify({
    v: 2,
    meetingId: String(meetingId),
    recordingId: recordingId ? String(recordingId) : null,
    dispatchKey: String(dispatchKey),
    hmacToken: String(hmacToken),
    language,
  });
}

/** True unless LIVEKIT_AGENTS_ENABLED is explicitly false (Joi default: true). */
export function isLivekitAgentsEnabled() {
  return config.livekit?.agentsEnabled !== false;
}

function agentsEnabled() {
  return isLivekitAgentsEnabled();
}

export function getAgentName() {
  return config.livekit?.summaryAgentName || 'meeting-summary-agent';
}

async function requestSummaryCancel(active, meetingId) {
  // Record the intent first: the salvage sweep keys on cancelRequestedAt, so a failed or impossible LiveKit call
  // (network error, dispatch already gone, no client) must not leave the stop unrecorded.
  await AgentDispatch.updateOne(
    { _id: active._id, cancelRequestedAt: null },
    { $set: { cancelRequestedAt: new Date() } }
  );
  logger.info('[AgentDispatch] cancel requested (summary)', {
    meetingId,
    dispatchId: active.dispatchId,
    recordingId: active.recordingId?.toString?.(),
  });
  if (!dispatchClient) return;
  try {
    await dispatchClient.deleteDispatch(active.dispatchId, meetingId);
  } catch (err) {
    logger.warn('[AgentDispatch] deleteDispatch failed', { dispatchId: active.dispatchId, error: err.message });
  }
  if (active.agentIdentity) {
    try {
      const { disconnectParticipant } = await import('./livekit.service.js');
      // ponytail: re-dispatch after removing the agent is unverified (V1); log-only on failure.
      await disconnectParticipant(meetingId, active.agentIdentity);
    } catch (remErr) {
      logger.warn('[AgentDispatch] agent disconnect after cancel failed', {
        meetingId,
        identity: active.agentIdentity,
        error: remErr.message,
      });
    }
  }
}

const DISPATCH_ATTEMPTS = 3;

/**
 * Bounded retry around AgentDispatchClient.createDispatch.
 *
 * ponytail: doubling backoff capped at 8 s, no jitter. Dispatch is a
 * once-per-recording call, so contention is not a concern; if that changes,
 * add jitter the way node_client does.
 */
export async function createDispatchWithRetry(
  dispatchClient,
  { room, agentName, metadata, attempts = DISPATCH_ATTEMPTS, sleepFn }
) {
  if (!dispatchClient) {
    return {
      ok: false,
      dispatchId: null,
      attempts: 0,
      error: 'AgentDispatchClient not initialized — LiveKit credentials missing',
    };
  }
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const max = Math.max(1, attempts);
  let backoff = 500;
  let lastError = null;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      const dispatch = await dispatchClient.createDispatch(room, agentName, { metadata });
      return { ok: true, dispatchId: dispatch.id, attempts: attempt, error: null };
    } catch (err) {
      lastError = err?.message || String(err);
      logger.warn('[AgentDispatch] createDispatch attempt failed', { room, attempt, error: lastError });
      if (attempt < max) {
        await sleep(backoff);
        backoff = Math.min(8000, backoff * 2);
      }
    }
  }
  return { ok: false, dispatchId: null, attempts: max, error: lastError };
}

export async function dispatchSummaryAgent({ meetingId, recordingId }) {
  if (!agentsEnabled()) {
    logger.info('[AgentDispatch] summary agent disabled (LIVEKIT_AGENTS_ENABLED=false)', { meetingId });
    return null;
  }
  const agentName = getAgentName();
  const hmacToken = crypto.randomBytes(32).toString('hex');
  const dispatchKey = crypto.randomBytes(16).toString('hex');
  const meeting = await getMeetingByMeetingId(meetingId);
  const language = meeting?.interviewLanguage || 'en';
  const metadata = buildDispatchMetadataV2({
    meetingId,
    recordingId,
    hmacToken,
    dispatchKey,
    language,
  });
  const attempt = await createDispatchWithRetry(dispatchClient, {
    room: meetingId,
    agentName,
    metadata,
  });
  if (!attempt.ok) {
    const err = new Error(attempt.error || 'createDispatch failed');
    err.failureStage = 'dispatch_failed';
    throw err;
  }
  const dispatch = { id: attempt.dispatchId };

  await AgentDispatch.create({
    meetingId,
    recordingId: recordingId || null,
    dispatchId: dispatch.id,
    dispatchKey,
    agentName,
    hmacToken,
    status: 'requested',
  });

  logger.info('[AgentDispatch] created', { meetingId, dispatchId: dispatch.id });
  return dispatch.id;
}

export async function cancelDispatch(meetingId, agentName = getAgentName()) {
  const active = await AgentDispatch.findOne({
    meetingId,
    agentName,
    status: { $in: ['requested', 'running'] },
  });
  if (!active) return;

  if (agentName === getAgentName()) {
    await requestSummaryCancel(active, meetingId);
    return;
  }

  if (!dispatchClient) return;
  try {
    await dispatchClient.deleteDispatch(active.dispatchId, meetingId);
    active.status = 'completed';
    active.leftAt = new Date();
    await active.save();
    logger.info('[AgentDispatch] cancelled', { meetingId, agentName, dispatchId: active.dispatchId });
  } catch (err) {
    logger.warn('[AgentDispatch] cancel failed', { agentName, dispatchId: active.dispatchId, error: err.message });
  }
}

export async function cancelSummaryDispatchForRecording(recordingId) {
  if (!recordingId) return;
  const active = await AgentDispatch.findOne({
    recordingId,
    agentName: getAgentName(),
    status: { $in: ['requested', 'running'] },
  });
  if (!active) return;
  await requestSummaryCancel(active, active.meetingId);
}

export async function cancelAllDispatches(meetingId) {
  await cancelDispatch(meetingId, getAgentName());
  await cancelDispatch(meetingId, ASSISTANT_AGENT_NAME);
}

export function getAssistantAgentName() {
  return ASSISTANT_AGENT_NAME;
}

async function hasActiveDispatch(meetingId, agentName) {
  const existing = await AgentDispatch.findOne({
    meetingId,
    agentName,
    status: { $in: ['requested', 'running'] },
  });
  return Boolean(existing);
}

/**
 * Dispatch the interactive meeting-assistant agent (wake-phrase gated).
 * Idempotent per meetingId — does nothing if an active assistant dispatch already exists.
 */
export async function dispatchAssistantAgent({ meetingId }) {
  if (!agentsEnabled()) {
    logger.info('[AgentDispatch] assistant agent disabled (LIVEKIT_AGENTS_ENABLED=false)', { meetingId });
    return null;
  }
  if (!dispatchClient) {
    throw new Error('AgentDispatchClient not initialized — LiveKit credentials missing');
  }
  if (await hasActiveDispatch(meetingId, ASSISTANT_AGENT_NAME)) {
    logger.info('[AgentDispatch] assistant already dispatched, skipping', { meetingId });
    return null;
  }
  const hmacToken = crypto.randomBytes(32).toString('hex');
  const metadata = buildDispatchMetadata({ meetingId, recordingId: null, hmacToken });
  const dispatch = await dispatchClient.createDispatch(meetingId, ASSISTANT_AGENT_NAME, { metadata });

  await AgentDispatch.create({
    meetingId,
    recordingId: null,
    dispatchId: dispatch.id,
    agentName: ASSISTANT_AGENT_NAME,
    hmacToken,
    status: 'requested',
  });

  logger.info('[AgentDispatch] assistant created', { meetingId, dispatchId: dispatch.id });
  return dispatch.id;
}
