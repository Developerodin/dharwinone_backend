import mongoose from 'mongoose';

/**
 * Unreconciled audit writes when ActivityLog persistence fails after a successful mutation.
 * Ops can replay from this collection per ORGANIZATION_AUDIT_RUNBOOK.md.
 */
const activityLogOutboxSchema = mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    route: { type: String, default: null },
    requestId: { type: String, default: null },
    occurredAt: { type: Date, default: () => new Date() },
    attempts: { type: Number, default: 1 },
    lastError: { type: String, default: null },
    reconciledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

activityLogOutboxSchema.index({ reconciledAt: 1, createdAt: -1 });
activityLogOutboxSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const ActivityLogOutbox = mongoose.model('ActivityLogOutbox', activityLogOutboxSchema);
export default ActivityLogOutbox;
