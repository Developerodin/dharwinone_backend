import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * Immutable audit event for domain actions (e.g. placement status).
 * No update/delete — only insert via service.
 */
const auditEventSchema = new mongoose.Schema(
  {
    targetType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    fromValue: { type: String, default: null },
    toValue: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditEventSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

auditEventSchema.plugin(toJSON);

const AuditEvent = mongoose.model('AuditEvent', auditEventSchema);
export default AuditEvent;
