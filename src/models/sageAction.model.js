import mongoose from 'mongoose';

export const SAGE_ACTION_STATUSES = ['pending', 'executing', 'done', 'failed', 'cancelled', 'expired'];

/**
 * A write Sage drafted in chat (agent/sageActions.js). The model only creates the
 * pending draft; the user's POST /v1/chat-assistant/actions/:key/confirm performs it.
 * Holds ids and the display summary only — no other PII.
 *
 * expiresAt: now + 15 min while pending, bumped to now + 24 h once terminal so the
 * result stays readable; the TTL index then removes the row.
 */
const sageActionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tool: { type: String, required: true },
    args: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** { title, lines, targetCount, targets: [{ id, name }], confirmLabel? } */
    summary: { type: mongoose.Schema.Types.Mixed, required: true },
    /** What commit needs (ids, not names). */
    payload: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: SAGE_ACTION_STATUSES, default: 'pending', required: true },
    /** { ok, message, details? } once terminal. */
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: true }
);

sageActionSchema.index({ key: 1 }, { unique: true });
// Production autoIndex is false — create the { expiresAt: 1 } TTL index on the server; shipping this file does not.
sageActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SageAction = mongoose.model('SageAction', sageActionSchema);
export default SageAction;
