import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const hrmDeviceTokenSchema = mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      index: true,
    },
    tokenJti: {
      type: String,
      required: true,
      unique: true,
    },
    issuedBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revoked: {
      type: Boolean,
      default: false,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      default: null,
    },
    label: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

hrmDeviceTokenSchema.plugin(toJSON);

const HrmDeviceToken = mongoose.model('HrmDeviceToken', hrmDeviceTokenSchema);

export default HrmDeviceToken;
