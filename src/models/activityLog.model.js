import mongoose from 'mongoose';
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
  },
  {
    timestamps: true,
  }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ actor: 1, createdAt: -1 });
activityLogSchema.index({ entityType: 1, entityId: 1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
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
