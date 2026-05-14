import crypto from 'crypto';
import { AgentDispatchClient } from 'livekit-server-sdk';
import config from '../config/config.js';
import logger from '../config/logger.js';
import AgentDispatch from '../models/agentDispatch.model.js';

const AGENT_NAME = 'meeting-summary-agent';
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

export async function dispatchSummaryAgent({ meetingId, recordingId }) {
  if (!dispatchClient) {
    throw new Error('AgentDispatchClient not initialized — LiveKit credentials missing');
  }
  const hmacToken = crypto.randomBytes(32).toString('hex');
  const metadata = buildDispatchMetadata({ meetingId, recordingId, hmacToken });
  const dispatch = await dispatchClient.createDispatch(meetingId, AGENT_NAME, { metadata });

  await AgentDispatch.create({
    meetingId,
    recordingId: recordingId || null,
    dispatchId: dispatch.id,
    hmacToken,
    status: 'requested',
  });

  logger.info('[AgentDispatch] created', { meetingId, dispatchId: dispatch.id });
  return dispatch.id;
}

export async function cancelDispatch(meetingId, agentName = AGENT_NAME) {
  const active = await AgentDispatch.findOne({
    meetingId,
    agentName,
    status: { $in: ['requested', 'running'] },
  });
  if (!active || !dispatchClient) return;
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

export async function cancelAllDispatches(meetingId) {
  await cancelDispatch(meetingId, AGENT_NAME);
  await cancelDispatch(meetingId, ASSISTANT_AGENT_NAME);
}

export function getAgentName() {
  return AGENT_NAME;
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
