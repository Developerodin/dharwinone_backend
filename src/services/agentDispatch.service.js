import crypto from 'crypto';
import { AgentDispatchClient } from 'livekit-server-sdk';
import config from '../config/config.js';
import logger from '../config/logger.js';
import AgentDispatch from '../models/agentDispatch.model.js';

const AGENT_NAME = 'meeting-summary-agent';

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

export async function cancelDispatch(meetingId) {
  const active = await AgentDispatch.findOne({
    meetingId,
    status: { $in: ['requested', 'running'] },
  });
  if (!active || !dispatchClient) return;
  try {
    await dispatchClient.deleteDispatch(active.dispatchId, meetingId);
    active.status = 'completed';
    active.leftAt = new Date();
    await active.save();
    logger.info('[AgentDispatch] cancelled', { meetingId, dispatchId: active.dispatchId });
  } catch (err) {
    logger.warn('[AgentDispatch] cancel failed', { dispatchId: active.dispatchId, error: err.message });
  }
}

export function getAgentName() {
  return AGENT_NAME;
}
