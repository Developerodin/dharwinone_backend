import mongoose from 'mongoose';

/**
 * One-time consent-based support camera session (LiveKit).
 * Target user must open join link while logged in and allow camera in their browser.
 */
const supportCameraInviteSchema = new mongoose.Schema(
  {
    // `unique: true` on token already creates a unique index; `index: true` here
    // would create the same single-field index twice ("Duplicate schema index" warning).
    token: {
      type: String,
      required: true,
      unique: true,
    },
    roomName: {
      type: String,
      required: true,
      trim: true,
    },
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // TTL index declared below via `schema.index({expiresAt: 1}, {expireAfterSeconds: 0})`;
    // `index: true` here creates a redundant non-TTL index alongside the TTL one.
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

supportCameraInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SupportCameraInvite = mongoose.model('SupportCameraInvite', supportCameraInviteSchema);

export default SupportCameraInvite;
