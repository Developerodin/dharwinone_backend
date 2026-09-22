import mongoose from 'mongoose';

/**
 * Cached LLM hire-forecast overlay keyed by a signature of pipeline signals.
 * TTL index drops rows after expiresAt so a changed pipeline recomputes even if
 * the signature somehow collides later.
 */
const hireForecastCacheSchema = new mongoose.Schema(
  {
    signature: { type: String, required: true, unique: true, trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

hireForecastCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const HireForecastCache = mongoose.model('HireForecastCache', hireForecastCacheSchema);
export default HireForecastCache;
