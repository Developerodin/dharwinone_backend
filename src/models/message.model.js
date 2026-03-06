import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    key: { type: String },
    originalName: { type: String },
    size: { type: Number, default: 0 },
    mimeType: { type: String, default: '' },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, default: '' },
    type: { type: String, enum: ['text', 'image', 'file', 'audio'], default: 'text' },
    attachments: [attachmentSchema],
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    reactions: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, emoji: { type: String, trim: true } }],
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    deletedAt: { type: Date, default: null },
    deletedFor: { type: String, enum: ['me', 'everyone'], default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.plugin(toJSON);

export default mongoose.model('Message', messageSchema);
