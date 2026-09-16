import mongoose from 'mongoose';

/**
 * Per-recipient daily send record for a smart nudge situation + entity.
 * Unique key prevents duplicate nudges on the same calendar day.
 */
const smartNudgeStateSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    situation: { type: String, required: true, trim: true, index: true },
    entityType: { type: String, required: true, trim: true },
    entityId: { type: String, required: true, trim: true },
    dateBucket: { type: String, required: true, trim: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

smartNudgeStateSchema.index(
  { recipient: 1, situation: 1, entityType: 1, entityId: 1, dateBucket: 1 },
  { unique: true }
);
smartNudgeStateSchema.index({ recipient: 1, dateBucket: 1 });

const SmartNudgeState = mongoose.model('SmartNudgeState', smartNudgeStateSchema);
export default SmartNudgeState;
