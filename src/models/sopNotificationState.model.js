import mongoose from 'mongoose';

/**
 * Dedupe in-app SOP reminders: one logical slot per recipient × candidate × step × day (or batch key).
 */
const sopNotificationStateSchema = new mongoose.Schema(
  {
    recipientUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', required: true, index: true },
    checkerKey: { type: String, required: true, trim: true },
    dateBucket: { type: String, required: true, trim: true },
    lastNotifiedAt: { type: Date, default: Date.now },
    batchSignature: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

sopNotificationStateSchema.index(
  { recipientUser: 1, candidate: 1, checkerKey: 1, dateBucket: 1 },
  { unique: true }
);

const SopNotificationState = mongoose.model('SopNotificationState', sopNotificationStateSchema);

export default SopNotificationState;
