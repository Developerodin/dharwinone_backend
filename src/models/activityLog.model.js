import mongoose from 'mongoose';
import config from '../config/config.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Activity log for audit and compliance.
 * Records who did what to which entity, when. Do not store sensitive PII in metadata.
 */
const activityLogSchema = mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      required: true,
      index: true,
    },
    entityId: {
      type: String,
      required: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ip: {
      type: String,
      default: null,
    },
    /** Optional browser-reported public IP (x-client-ip); prefer for geo/display when set. Server `ip` remains the TCP/proxy peer. */
    clientIp: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
    httpMethod: {
      type: String,
      default: null,
    },
    httpPath: {
      type: String,
      default: null,
    },
    geo: {
      country: { type: String, default: null },
      region: { type: String, default: null },
      city: { type: String, default: null },
    },
    /**
     * Optional device location from browser (reverse-geocoded to city/region/country; lat/lng not stored for new writes).
     * Legacy documents may still have lat/lng.
     */
    clientGeo: {
      city: { type: String, default: null },
      region: { type: String, default: null },
      country: { type: String, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracyM: { type: Number, default: null },
      capturedAt: { type: Date, default: null },
      source: { type: String, default: null },
    },
  },
  {
    timestamps: true,
  }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ actor: 1, createdAt: -1 });
activityLogSchema.index({ entityType: 1, entityId: 1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
if (config.activityLog?.ttlSeconds > 0) {
  activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.activityLog.ttlSeconds });
}
activityLogSchema.plugin(paginate);

activityLogSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

export default ActivityLog;
