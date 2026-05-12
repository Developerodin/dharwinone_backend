import crypto from 'crypto';
import httpStatus from 'http-status';
import AgentDispatch from '../models/agentDispatch.model.js';
import logger from '../config/logger.js';

const MAX_SKEW_MS = 5 * 60 * 1000;

export function signAgentRequest({ token, timestamp, body }) {
  return crypto.createHmac('sha256', token).update(`${timestamp}.${body}`).digest('hex');
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
  const { meetingId } = req.params;
  const signature = req.get('X-Agent-Signature');
  const timestamp = req.get('X-Agent-Timestamp');

  if (!meetingId) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'meetingId required' });
  }
  if (!signature || !timestamp) {
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'missing agent auth headers' });
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'stale timestamp' });
  }

  const dispatch = await AgentDispatch.findOne({
    meetingId,
    status: { $in: ['requested', 'running'] },
  });
  if (!dispatch) {
    return res.status(httpStatus.UNAUTHORIZED).json({ message: 'no active dispatch' });
  }

  const rawBody = req.rawBody
    ? Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : String(req.rawBody)
    : JSON.stringify(req.body || {});

  const expected = signAgentRequest({
    token: dispatch.hmacToken,
    timestamp: String(ts),
    body: rawBody,
  });

  let ok = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length === b.length) {
      ok = crypto.timingSafeEqual(a, b);
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    logger.warn('[AgentAuth] bad signature', { meetingId, dispatchId: dispatch.dispatchId });
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
