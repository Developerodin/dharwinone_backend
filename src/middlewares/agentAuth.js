import crypto from 'crypto';
import httpStatus from 'http-status';
import AgentDispatch from '../models/agentDispatch.model.js';
import logger from '../config/logger.js';
import { getAgentName } from '../services/agentDispatch.service.js';

const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_DISPATCH_CANDIDATES = 5;
const RUN_ID_RE = /^[a-f0-9]{16}$/;

export function signAgentRequest({ token, timestamp, body }) {
  return crypto.createHmac('sha256', token).update(`${timestamp}.${body}`).digest('hex');
}

export function signAgentRequestV2({ hmacToken, timestamp, dispatchKey, runId, rawBody }) {
  const payload = `${timestamp}.${dispatchKey}.${runId}.${rawBody}`;
  return crypto.createHmac('sha256', hmacToken).update(payload).digest('hex');
}

function unauthorizedV2(res, reason) {
  logger.warn('[AgentAuth] rejected v2', { reason });
  return res.status(httpStatus.UNAUTHORIZED).json({ message: 'unauthorized', reason });
}

/**
 * Returns the first candidate whose hmacToken signs `${timestamp}.${rawBody}` to `signature`, else null.
 * ponytail: tries up to MAX_DISPATCH_CANDIDATES tokens per request, because a meeting can hold several active summary
 * dispatches (one per recording). Upgrade path: protocol v2 sends an opaque dispatch key so the row is looked up directly.
 */
export function pickVerifiedDispatch(candidates, { timestamp, signature, rawBody }) {
  if (!Array.isArray(candidates) || !signature || rawBody == null) {
    return null;
  }
  for (const dispatch of candidates) {
    if (!dispatch?.hmacToken) continue;
    const expected = signAgentRequest({
      token: dispatch.hmacToken,
      timestamp: String(timestamp),
      body: rawBody,
    });
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return dispatch;
      }
    } catch {
      // malformed signature hex — try next candidate
    }
  }
  return null;
}

async function verifyAgentHmacV2(req, res) {
  const { meetingId } = req.params;
  const dispatchKey = req.get('X-Agent-Dispatch-Key');
  const runId = req.get('X-Agent-Run-Id');
  const signature = req.get('X-Agent-Signature');
  const timestamp = req.get('X-Agent-Timestamp');

  if (!dispatchKey || !runId || !signature || !timestamp) {
    return unauthorizedV2(res, 'missing_headers');
  }
  if (!RUN_ID_RE.test(runId)) {
    return unauthorizedV2(res, 'bad_run_id');
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return unauthorizedV2(res, 'stale_timestamp');
  }

  const dispatch = await AgentDispatch.findOne({ dispatchKey }).lean();
  if (!dispatch || dispatch.agentName !== getAgentName() || !['requested', 'running'].includes(dispatch.status)) {
    return unauthorizedV2(res, 'no_active_dispatch');
  }
  if (dispatch.meetingId !== meetingId) {
    return unauthorizedV2(res, 'meeting_mismatch');
  }

  const rawBody = req.rawBody
    ? Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : String(req.rawBody)
    : JSON.stringify(req.body || {});

  const expected = signAgentRequestV2({
    hmacToken: dispatch.hmacToken,
    timestamp: String(ts),
    dispatchKey,
    runId,
    rawBody,
  });
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return unauthorizedV2(res, 'bad_signature');
    }
  } catch {
    return unauthorizedV2(res, 'bad_signature');
  }

  req.agentDispatch = {
    id: dispatch._id,
    dispatchId: dispatch.dispatchId,
    dispatchKey: dispatch.dispatchKey,
    meetingId: dispatch.meetingId,
    recordingId: dispatch.recordingId,
    status: dispatch.status,
    agentName: dispatch.agentName,
  };
  req.agentRunId = runId;
  return null;
}

/**
 * Express middleware. Requires:
 *   X-Agent-Timestamp: <ms epoch>
 *   X-Agent-Signature: hex(hmacSha256(dispatch.hmacToken, `${timestamp}.${rawBody}`))
 *
 * Loads AgentDispatch by req.params.meetingId where status in {requested, running},
 * recomputes HMAC over req.rawBody, timingSafeEqual.
 *
 * On success, attaches req.agentDispatch (sans hmacToken) and calls next().
 */
export async function verifyAgentHmac(req, res, next) {
  const authVersion = req.get('X-Agent-Auth-Version');
  if (authVersion === '2') {
    const errRes = await verifyAgentHmacV2(req, res);
    if (errRes) return errRes;
    return next();
  }

  const { meetingId } = req.params;
  const signature = req.get('X-Agent-Signature');
  const timestamp = req.get('X-Agent-Timestamp');

  if (!meetingId) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'meetingId required' });
  }
  if (!signature || !timestamp) {
    logger.warn('[AgentAuth] rejected', { meetingId, reason: 'missing_headers' });
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'missing agent auth headers' });
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    logger.warn('[AgentAuth] rejected', { meetingId, reason: 'stale_timestamp' });
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'stale timestamp' });
  }

  const candidates = await AgentDispatch.find({
    meetingId,
    agentName: getAgentName(),
    status: { $in: ['requested', 'running'] },
  })
    .sort({ createdAt: -1 })
    .limit(MAX_DISPATCH_CANDIDATES);

  if (!candidates.length) {
    logger.warn('[AgentAuth] rejected', { meetingId, reason: 'no_active_dispatch', candidates: 0 });
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'no active dispatch' });
  }

  const rawBody = req.rawBody
    ? Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : String(req.rawBody)
    : JSON.stringify(req.body || {});

  const dispatch = pickVerifiedDispatch(candidates, {
    timestamp: String(ts),
    signature,
    rawBody,
  });

  if (!dispatch) {
    logger.warn('[AgentAuth] bad signature', { meetingId, candidates: candidates.length });
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'bad signature' });
  }

  req.agentDispatch = {
    id: dispatch._id,
    dispatchId: dispatch.dispatchId,
    meetingId: dispatch.meetingId,
    recordingId: dispatch.recordingId,
    status: dispatch.status,
  };
  return next();
}

export function requireProtocolV2(req, res, next) {
  if (!req.agentRunId || !req.agentDispatch?.dispatchKey) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'protocol_v2_required' });
  }
  return next();
}
