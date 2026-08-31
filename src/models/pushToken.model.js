import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * A mobile device's Expo push token, owned by a user. A token is globally unique:
 * if a device re-registers under a different user (account switch), the row is reassigned.
 * Invalid tokens (Expo "DeviceNotRegistered") are pruned by the push service.
 *
 * soundEnabled / vibrationEnabled / notificationsEnabled mirror Account Settings toggles
 * so Expo pushes honor ON/OFF without requiring a fresh token round-trip every time.
 */
const pushTokenSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web'],
      default: undefined,
    },
    deviceName: {
      type: String,
      default: null,
    },
    /** Master App Notifications toggle — false skips all pushes to this device. */
    notificationsEnabled: {
      type: Boolean,
      default: true,
    },
    soundEnabled: {
      type: Boolean,
      default: true,
    },
    vibrationEnabled: {
      type: Boolean,
      default: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

pushTokenSchema.plugin(toJSON);

/**
 * @typedef PushToken
 */
const PushToken = mongoose.model('PushToken', pushTokenSchema);

export default PushToken;
