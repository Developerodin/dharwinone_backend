import mongoose from 'mongoose';

/**
 * Cached LLM applicant-fit overlay keyed by a signature of JD + skills + profile.
 * TTL index drops rows after expiresAt so a changed JD/skills recomputes.
 */
const applicantFitCacheSchema = new mongoose.Schema(
  {
    signature: { type: String, required: true, unique: true, trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

applicantFitCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ApplicantFitCache = mongoose.model('ApplicantFitCache', applicantFitCacheSchema);
export default ApplicantFitCache;
