import { Expo } from 'expo-server-sdk';
import httpStatus from 'http-status';
import PushToken from '../models/pushToken.model.js';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';

// accessToken is optional — Expo push works without it, but setting EXPO_ACCESS_TOKEN
// enables enhanced security (token-scoped sends) and higher rate limits.
const expo = new Expo(config.expo?.accessToken ? { accessToken: config.expo.accessToken } : {});

/**
 * Register (or refresh) a device's Expo push token for a user.
 * Upserts by token so a device that switches accounts is reassigned, not duplicated.
 */
export async function registerPushToken(userId, { token, platform, deviceName }) {
  if (!token || !Expo.isExpoPushToken(token)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A valid Expo push token is required.');
  }
  const doc = await PushToken.findOneAndUpdate(
    { token },
    {
      user: userId,
      token,
      ...(platform ? { platform } : {}),
      ...(deviceName ? { deviceName } : {}),
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/** Remove a device token (e.g. on logout). Scoped to the owning user. */
export async function unregisterPushToken(userId, token) {
  if (!token) return;
  await PushToken.deleteOne({ token, user: userId });
}

/**
 * FCM/Expo require string values in Android data maps.
 * Nested objects are JSON-stringified; primitives coerced to string.
 */
function stringifyDataFields(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

/**
 * Build an Expo push message.
 *
 * Always send a visible Notification Message (top-level title/body) so the OS
 * can present it when the app is backgrounded or force-killed. Headless
 * data-only Android payloads required a JS background task to call
 * scheduleNotificationAsync — that task often never runs after a force-stop,
 * so chat/mail pushes silently disappeared.
 *
 * categoryId is still attached for iOS interactive actions (Reply / Mark as Read).
 * On Android, OS-presented Notification Messages may not show action buttons;
 * reliability of delivery takes priority over shade actions.
 *
 * @param {string} token
 * @param {'ios'|'android'|'web'|undefined} platform
 * @param {{ title: string, body: string, data?: object, channelId?: string, categoryId?: string }} message
 */
function buildExpoPushMessage(token, _platform, { title, body, data = {}, channelId, categoryId }) {
  const appData = stringifyDataFields(data);

  return {
    to: token,
    sound: 'default',
    priority: 'high',
    title: title || 'Notification',
    body: body || '',
    data: {
      ...appData,
      // Keep category/channel in data for routing and legacy background-task paths.
      ...(categoryId ? { categoryId } : {}),
      ...(channelId ? { channelId } : {}),
    },
    ...(channelId ? { channelId } : {}),
    ...(categoryId ? { categoryId } : {}),
  };
}

/**
 * Send a push to every device registered for a user. Fire-and-forget at call sites
 * (wrap in .catch) so notification delivery never blocks the triggering request.
 * @param {string} userId
 * @param {{ title: string, body: string, data?: object, channelId?: string, categoryId?: string }} message
 */
export async function sendPushToUser(userId, { title, body, data = {}, channelId, categoryId } = {}) {
  const rows = await PushToken.find({ user: userId }).select('token platform').lean();
  if (!rows.length) return { sent: 0 };
  return sendPushToTokenRows(rows, { title, body, data, channelId, categoryId });
}

/**
 * Send a push to explicit tokens. Chunks per Expo limits and prunes tokens that
 * Expo reports as DeviceNotRegistered.
 * @param {string[]} tokens
 */
export async function sendPushToTokens(tokens, { title, body, data = {}, channelId, categoryId } = {}) {
  const rows = tokens.map((token) => ({ token, platform: undefined }));
  return sendPushToTokenRows(rows, { title, body, data, channelId, categoryId });
}

async function sendPushToTokenRows(rows, { title, body, data = {}, channelId, categoryId } = {}) {
  const messages = [];
  for (const row of rows) {
    const token = row.token;
    if (!Expo.isExpoPushToken(token)) continue;
    // Unknown platform is fine — all platforms now receive the same visible alert path.
    messages.push(
      buildExpoPushMessage(token, row.platform, { title, body, data, channelId, categoryId })
    );
  }
  if (!messages.length) return { sent: 0 };

  const chunks = expo.chunkPushNotifications(messages);
  const invalidTokens = [];
  let sent = 0;
  for (const chunk of chunks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < receipts.length; i += 1) {
        const receipt = receipts[i];
        if (receipt.status === 'error') {
          logger.warn('[push] send error: %s', receipt.message);
          if (receipt.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(chunk[i].to);
          }
        } else {
          sent += 1;
        }
      }
    } catch (err) {
      logger.error('[push] chunk send failed: %s', err?.message);
    }
  }

  if (invalidTokens.length) {
    await PushToken.deleteMany({ token: { $in: invalidTokens } });
    logger.info('[push] pruned %d unregistered tokens', invalidTokens.length);
  }
  return { sent };
}
