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
 * Map Account Settings sound/vibration prefs → Android channel id.
 * Client creates matching channels (same base ids the app already uses).
 * Both-on keeps the legacy id so older clients keep working.
 */
export function channelIdForPrefs(baseChannelId, soundEnabled = true, vibrationEnabled = true) {
  if (!baseChannelId) return baseChannelId;
  const sound = soundEnabled !== false;
  const vibrate = vibrationEnabled !== false;
  if (sound && vibrate) return baseChannelId;
  if (sound && !vibrate) return `${baseChannelId}-novibrate`;
  if (!sound && vibrate) return `${baseChannelId}-nosound`;
  return `${baseChannelId}-quiet`;
}

/**
 * Register (or refresh) a device's Expo push token for a user.
 * Upserts by token so a device that switches accounts is reassigned, not duplicated.
 */
export async function registerPushToken(
  userId,
  { token, platform, deviceName, soundEnabled, vibrationEnabled, notificationsEnabled },
) {
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
      ...(typeof soundEnabled === 'boolean' ? { soundEnabled } : {}),
      ...(typeof vibrationEnabled === 'boolean' ? { vibrationEnabled } : {}),
      ...(typeof notificationsEnabled === 'boolean' ? { notificationsEnabled } : { notificationsEnabled: true }),
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
 * Update Account Settings notification prefs.
 * When `token` is provided, only that device row is updated (correct for multi-device).
 * Without a token, all of the user's tokens are updated (best-effort fallback).
 */
export async function updatePushPreferences(
  userId,
  { soundEnabled, vibrationEnabled, notificationsEnabled, token } = {},
) {
  const $set = { lastSeenAt: new Date() };
  if (typeof soundEnabled === 'boolean') $set.soundEnabled = soundEnabled;
  if (typeof vibrationEnabled === 'boolean') $set.vibrationEnabled = vibrationEnabled;
  if (typeof notificationsEnabled === 'boolean') $set.notificationsEnabled = notificationsEnabled;

  if (Object.keys($set).length <= 1) {
    return { matched: 0, modified: 0 };
  }

  const filter = token ? { user: userId, token } : { user: userId };
  const result = await PushToken.updateMany(filter, { $set });
  return {
    matched: result.matchedCount ?? result.n ?? 0,
    modified: result.modifiedCount ?? result.nModified ?? 0,
  };
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
 * Sound / Android channel follow the device Account Settings prefs stored on
 * the PushToken — otherwise toggles OFF still play sound (Expo defaults to
 * sound: 'default') and vibrate via the loud channel.
 */
function buildExpoPushMessage(
  token,
  _platform,
  {
    title,
    body,
    data = {},
    channelId,
    categoryId,
    richContent,
    mutableContent,
    soundEnabled = true,
    vibrationEnabled = true,
  },
) {
  const appData = stringifyDataFields(data);
  const playSound = soundEnabled !== false;
  const resolvedChannelId = channelIdForPrefs(channelId, playSound, vibrationEnabled !== false);

  const message = {
    to: token,
    priority: 'high',
    title: title || 'Notification',
    body: body || '',
    data: {
      ...appData,
      ...(categoryId ? { categoryId } : {}),
      ...(resolvedChannelId ? { channelId: resolvedChannelId } : {}),
    },
    ...(resolvedChannelId ? { channelId: resolvedChannelId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(richContent?.image ? { richContent: { image: richContent.image } } : {}),
    ...(mutableContent ? { mutableContent: true } : {}),
  };

  // Explicit silent: omit sound key when off (some Expo/FCM paths treat null as default).
  if (playSound) {
    message.sound = 'default';
  } else {
    message.sound = null;
  }

  return message;
}

/**
 * Send a push to every device registered for a user. Fire-and-forget at call sites
 * (wrap in .catch) so notification delivery never blocks the triggering request.
 */
export async function sendPushToUser(
  userId,
  { title, body, data = {}, channelId, categoryId, richContent, mutableContent } = {},
) {
  const rows = await PushToken.find({
    user: userId,
    notificationsEnabled: { $ne: false },
  })
    .select('token platform soundEnabled vibrationEnabled notificationsEnabled')
    .lean();
  if (!rows.length) return { sent: 0 };
  return sendPushToTokenRows(rows, { title, body, data, channelId, categoryId, richContent, mutableContent });
}

/**
 * Send a push to explicit tokens. Chunks per Expo limits and prunes tokens that
 * Expo reports as DeviceNotRegistered.
 */
export async function sendPushToTokens(
  tokens,
  { title, body, data = {}, channelId, categoryId, richContent, mutableContent } = {},
) {
  const rows = tokens.map((token) => ({
    token,
    platform: undefined,
    soundEnabled: true,
    vibrationEnabled: true,
  }));
  return sendPushToTokenRows(rows, { title, body, data, channelId, categoryId, richContent, mutableContent });
}

async function sendPushToTokenRows(
  rows,
  { title, body, data = {}, channelId, categoryId, richContent, mutableContent } = {},
) {
  const messages = [];
  for (const row of rows) {
    const token = row.token;
    if (!Expo.isExpoPushToken(token)) continue;
    messages.push(
      buildExpoPushMessage(token, row.platform, {
        title,
        body,
        data,
        channelId,
        categoryId,
        richContent,
        mutableContent,
        soundEnabled: row.soundEnabled !== false,
        vibrationEnabled: row.vibrationEnabled !== false,
      }),
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
