import mongoose from 'mongoose';

/**
 * Opaque task-breakdown preview snapshots (ADR-0042). TTL removes expired docs.
 * state: open → applied (apply) or superseded (refine).
 */
const taskBreakdownPreviewSchema = new mongoose.Schema(
  {
    previewId: { type: String, required: true, unique: true, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    state: { type: String, enum: ['open', 'applied', 'superseded'], default: 'open', index: true },
    breakdownContext: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Tasks with server-assigned `id` on each item */
    tasks: { type: [mongoose.Schema.Types.Mixed], required: true },
    /** Expiry for 24h window; combined with Mongo TTL. */
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

taskBreakdownPreviewSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'task_breakdown_preview_ttl' }
);

const TaskBreakdownPreview = mongoose.model('TaskBreakdownPreview', taskBreakdownPreviewSchema);

export default TaskBreakdownPreview;
