import config from '../config/config.js';
import logger from '../config/logger.js';
import SmartNudgeState from '../models/smartNudgeState.model.js';
import Notification from '../models/notification.model.js';
import User from '../models/user.model.js';
import { OVERLAP_WINDOW_MS } from '../constants/smartNudge.situations.js';
import { dateBucketUtc, copySignature, isObjectIdHex } from './smartNudge.helpers.js';
import { runAllDetectors } from './smartNudge.detector.js';
import { resolveCopies } from './smartNudge.copy.js';
import { notify, plainTextEmailBody } from './notification.service.js';

/**
 * Count smart nudges already recorded for this user today.
 * @param {string} userId
 * @param {string} dateBucket
 * @returns {Promise<number>}
 */
export const countToday = async (userId, dateBucket) =>
  SmartNudgeState.countDocuments({ recipient: userId, dateBucket });

/**
 * True when a transactional notification of an overlapping type already exists.
 * @param {object} event
 * @param {string} userId
 * @param {Date} now
 * @returns {Promise<boolean>}
 */
export const hasOverlap = async (event, userId, now) => {
  if (!event.overlapTypes?.length) return false;
  const since = new Date(now.getTime() - OVERLAP_WINDOW_MS);
  const entityId = String(event.relatedEntity?.id || event.entityId);
  const found = await Notification.findOne({
    user: userId,
    type: { $in: event.overlapTypes },
    createdAt: { $gte: since },
    $or: [{ 'relatedEntity.id': entityId }, { 'metadata.entityId': entityId }],
  })
    .select('_id')
    .lean();
  return Boolean(found);
};

/**
 * Resolve a User id from the event (userId or email lookup).
 * @param {object} event
 * @returns {Promise<string|null>}
 */
export const resolveUserId = async (event) => {
  if (event.userId && isObjectIdHex(event.userId)) return String(event.userId);
  if (!event.email) return null;
  const escaped = String(event.email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const user = await User.findOne({ email: new RegExp(`^${escaped}$`, 'i') })
    .select('_id')
    .lean();
  return user?._id ? String(user._id) : null;
};

/**
 * Record a successful send. Duplicate-key means another tick won the race.
 * @param {object} row
 * @returns {Promise<boolean>} true if this tick owns the send
 */
export const recordState = async (row) => {
  try {
    await SmartNudgeState.create(row);
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
};

/**
 * Detect stalls, resolve copy, send via existing notify(). Does not change other emitters.
 * @param {{ now?: Date, detect?: Function, copies?: Function, notifyFn?: Function, maxPerUser?: number }} [deps]
 * @returns {Promise<{ scanned: number, sent: number, skipped: number }>}
 */
export const runSmartNudgeTick = async (deps = {}) => {
  const now = deps.now || new Date();
  const maxPerUser = deps.maxPerUser ?? config.smartNudge?.maxPerUserPerDay ?? 3;
  const detect = deps.detect || runAllDetectors;
  const copiesFn = deps.copies || resolveCopies;
  const notifyFn = deps.notifyFn || notify;

  const events = await detect({ now });
  const stats = { scanned: events.length, sent: 0, skipped: 0 };
  if (!events.length) return stats;

  const copyMap = await copiesFn(events, { now });
  const today = dateBucketUtc(now);
  const todayCounts = new Map();

  for (const event of events) {
    try {
      const userId = deps.resolveUserId
        ? await deps.resolveUserId(event)
        : await resolveUserId(event);
      if (!userId) {
        stats.skipped += 1;
        continue;
      }
      if (!todayCounts.has(userId)) {
        const countFn = deps.countToday || countToday;
        todayCounts.set(userId, await countFn(userId, today));
      }
      if (todayCounts.get(userId) >= maxPerUser) {
        stats.skipped += 1;
        continue;
      }
      const overlapFn = deps.hasOverlap || hasOverlap;
      if (await overlapFn(event, userId, now)) {
        stats.skipped += 1;
        continue;
      }
      const claimed = await (deps.recordState || recordState)({
        recipient: userId,
        situation: event.situation,
        entityType: event.entityType,
        entityId: String(event.entityId),
        dateBucket: today,
        sentAt: now,
      });
      if (!claimed) {
        stats.skipped += 1;
        continue;
      }
      const sig = copySignature(event.facts);
      const copy = copyMap.get(sig) || { title: 'Reminder', message: event.facts.label || 'Please take action.' };
      const payload = {
        type: 'smart_nudge',
        title: copy.title,
        message: copy.message,
        link: event.link,
        relatedEntity: event.relatedEntity,
        metadata: { ...(event.metadata || {}), situation: event.situation, entityId: String(event.entityId) },
      };
      if (event.severity === 'high') {
        payload.email = {
          subject: copy.title,
          text: plainTextEmailBody(copy.message, event.link),
        };
      }
      await notifyFn(userId, payload);
      todayCounts.set(userId, todayCounts.get(userId) + 1);
      stats.sent += 1;
    } catch (err) {
      stats.skipped += 1;
      logger.warn(`[smartNudge] send failed (${event.situation}): ${err?.message || err}`);
    }
  }
  return stats;
};
