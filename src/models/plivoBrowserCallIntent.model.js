import mongoose from 'mongoose';

/**
 * Short-lived outbound browser-call metadata keyed by destination E.164.
 * Plivo sdk-answer often omits X-PH-callerId; the UI registers intent before client.call().
 */
const plivoBrowserCallIntentSchema = new mongoose.Schema(
  {
    dest: { type: String, required: true, unique: true, trim: true },
    callerId: { type: String, required: true, trim: true },
    intent: { type: String, trim: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

plivoBrowserCallIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PlivoBrowserCallIntent = mongoose.model('PlivoBrowserCallIntent', plivoBrowserCallIntentSchema);

export default PlivoBrowserCallIntent;
