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
 * Send a push to every device registered for a user. Fire-and-forget at call sites
 * (wrap in .catch) so notification delivery never blocks the triggering request.
 * @param {string} userId
 * @param {{ title: string, body: string, data?: object, channelId?: string }} message
 */
export async function sendPushToUser(userId, { title, body, data = {}, channelId } = {}) {
  const rows = await PushToken.find({ user: userId }).select('token').lean();
  const tokens = rows.map((r) => r.token);
  if (!tokens.length) return { sent: 0 };
  return sendPushToTokens(tokens, { title, body, data, channelId });
}

/**
 * Send a push to explicit tokens. Chunks per Expo limits and prunes tokens that
 * Expo reports as DeviceNotRegistered.
 */
export async function sendPushToTokens(tokens, { title, body, data = {}, channelId } = {}) {
  const messages = [];
  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) continue;
    messages.push({
      to: token,
      sound: 'default',
      priority: 'high',
      title,
      body,
      data,
      ...(channelId ? { channelId } : {}),
    });
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
