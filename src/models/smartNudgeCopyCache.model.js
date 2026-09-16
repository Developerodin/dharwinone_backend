import mongoose from 'mongoose';

/**
 * Cached AI nudge copy keyed by situation signature (not user).
 * TTL index drops rows after expiresAt so copy can refresh weekly.
 */
const smartNudgeCopyCacheSchema = new mongoose.Schema(
  {
    signature: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

smartNudgeCopyCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SmartNudgeCopyCache = mongoose.model('SmartNudgeCopyCache', smartNudgeCopyCacheSchema);
export default SmartNudgeCopyCache;
