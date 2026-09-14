import crypto from 'crypto';
import ProcessedWebhookEvent from '../models/processedWebhookEvent.model.js';
import logger from '../config/logger.js';

const RECLAIM_STALE_MS = 10 * 60 * 1000;

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

export function isReclaimable(doc, now = Date.now()) {
  if (!doc) return false;
  const status = doc.status || 'processed';
  if (status === 'failed') return true;
  if (status === 'processing') {
    const claimedAt = doc.claimedAt ? new Date(doc.claimedAt).getTime() : 0;
    return Number.isFinite(claimedAt) && claimedAt > 0 && now - claimedAt > RECLAIM_STALE_MS;
  }
  return false;
}

/**
 * Returns true if the event is newly claimed (or reclaimed), false if duplicate.
 */
export async function claimWebhookEvent({ eventId, event, roomName, bodyHash }) {
  const now = new Date();
  try {
    const res = await ProcessedWebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          event,
          roomName: roomName || null,
          bodyHash,
          receivedAt: now,
          status: 'processing',
          claimedAt: now,
          attempts: 1,
          lastError: null,
        },
      },
      { upsert: true, includeResultMetadata: true }
    );
    const existing = res.lastErrorObject?.updatedExisting === true;
    if (!existing) {
      return true;
    }

    const doc = await ProcessedWebhookEvent.findOne({ eventId }).lean();
    if (!isReclaimable(doc)) {
      logger.info('[WebhookIdempotency] duplicate event suppressed', { eventId, event });
      return false;
    }

    const reclaimed = await ProcessedWebhookEvent.findOneAndUpdate(
      {
        eventId,
        $or: [
          { status: 'failed' },
          { status: 'processing', claimedAt: { $lt: new Date(Date.now() - RECLAIM_STALE_MS) } },
        ],
      },
      { $set: { status: 'processing', claimedAt: now, lastError: null }, $inc: { attempts: 1 } },
      { new: true }
    );
    if (reclaimed) {
      logger.info('[WebhookIdempotency] reclaimed event for retry', { eventId, event, attempts: reclaimed.attempts });
      return true;
    }
    logger.info('[WebhookIdempotency] duplicate event suppressed (reclaim race)', { eventId, event });
    return false;
  } catch (err) {
    if (err?.code === 11000) {
      logger.info('[WebhookIdempotency] duplicate via unique index race', { eventId });
      return false;
    }
    throw err;
  }
}

export async function markWebhookEvent(eventId, status, error = null) {
  if (!eventId) return;
  await ProcessedWebhookEvent.updateOne(
    { eventId },
    {
      $set: {
        status,
        lastError: error ? String(error).slice(0, 1000) : null,
        ...(status === 'processing' ? { claimedAt: new Date() } : {}),
      },
    }
  );
}
