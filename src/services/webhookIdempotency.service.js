import crypto from 'crypto';
import ProcessedWebhookEvent from '../models/processedWebhookEvent.model.js';
import logger from '../config/logger.js';

export function computeBodyHash(body) {
  const buf =
    typeof body === 'string'
      ? body
      : Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body || '');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function computeEventId({ explicitId, timestamp, body }) {
  if (explicitId) return String(explicitId);
  const bh = computeBodyHash(body);
  return crypto.createHash('sha256').update(`${timestamp || ''}.${bh}`).digest('hex');
}

/**
 * Returns true if the event is new (was inserted), false if already seen.
 */
export async function claimWebhookEvent({ eventId, event, roomName, bodyHash }) {
  try {
    const res = await ProcessedWebhookEvent.findOneAndUpdate(
      { eventId },
      { $setOnInsert: { event, roomName: roomName || null, bodyHash, receivedAt: new Date() } },
      { upsert: true, rawResult: true }
    );
    const existing = res.lastErrorObject?.updatedExisting === true;
    if (existing) {
      logger.info('[WebhookIdempotency] duplicate event suppressed', { eventId, event });
    }
    return !existing;
  } catch (err) {
    if (err?.code === 11000) {
      logger.info('[WebhookIdempotency] duplicate via unique index race', { eventId });
      return false;
    }
    throw err;
  }
}
