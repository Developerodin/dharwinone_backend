import mongoose from 'mongoose';

/**
 * Cross-process lease for Bolna agent prompt PATCH + dial.
 * One document per agentId; TTL index drops expired leases automatically.
 */
const bolnaAgentPromptLockSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, unique: true, trim: true },
    holder: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

bolnaAgentPromptLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BolnaAgentPromptLock = mongoose.model('BolnaAgentPromptLock', bolnaAgentPromptLockSchema);

export default BolnaAgentPromptLock;
