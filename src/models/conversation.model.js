import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastReadAt: { type: Date, default: null },
    role: { type: String, enum: ['member', 'admin'], default: 'member' },
    /** Per-user: suppress in-app + push notifications until manually unmuted. */
    muted: { type: Boolean, default: false },
    /** Per-user: when set, conversation stays at the top of that user's chat list. */
    pinnedAt: { type: Date, default: null },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    participants: [participantSchema],
    name: { type: String, trim: true },
    /**
     * Group photo — same shape as User.profilePicture: S3 key + metadata; url refreshed on read (presigned).
     * Direct chats omit this field.
     */
    avatar: {
      url: { type: String, trim: true },
      key: { type: String, trim: true },
      originalName: { type: String, trim: true },
      size: { type: Number },
      mimeType: { type: String, trim: true },
    },
    description: { type: String, trim: true, default: '', maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true }
);

conversationSchema.index({ 'participants.user': 1 });
conversationSchema.index({ lastMessageAt: -1 });
conversationSchema.plugin(toJSON);

export default mongoose.model('Conversation', conversationSchema);
