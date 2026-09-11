import httpStatus from 'http-status';
import ApiError from './ApiError.js';

/**
 * Per-user cap on chat message creation.
 *
 * Enforced in chat.service.createMessage rather than as route middleware on purpose: messages
 * are created from three paths (REST send, REST upload, and the Socket.IO `send_message`
 * handler) and a route limiter would leave the socket path — the cheapest one to abuse —
 * completely open.
 *
 * ponytail: fixed window, in-memory, per process. A multi-instance deploy multiplies the
 * effective cap by the instance count, and a client can burst 2x across a window boundary.
 * Both are fine for bounding spam; move to the shared store the other limiters would need
 * anyway if this ever has to be an exact quota.
 */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60;
/** Entries are only dropped when their owner sends again, so bound the map for idle senders. */
const MAX_TRACKED_SENDERS = 10000;

const windows = new Map();

const assertChatSendAllowed = (userId, now = Date.now()) => {
  const key = String(userId);
  if (windows.size > MAX_TRACKED_SENDERS) windows.clear();

  const current = windows.get(key);
  if (!current || now >= current.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (current.count >= MAX_PER_WINDOW) {
    throw new ApiError(httpStatus.TOO_MANY_REQUESTS, 'You are sending messages too quickly. Please slow down.');
  }
  current.count += 1;
};

/** Test seam only. */
const resetChatSendRate = () => windows.clear();

export { assertChatSendAllowed, resetChatSendRate, MAX_PER_WINDOW, WINDOW_MS };
