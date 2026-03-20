import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const chatCallSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** Users who actually connected to the LiveKit room (subset of participants). */
    roomJoinedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    callType: { type: String, enum: ['audio', 'video'], required: true },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'ongoing', 'completed', 'missed', 'declined'],
      default: 'initiated',
    },
    livekitRoom: { type: String, trim: true },
    /** Reference to Recording when in-app call was recorded via LiveKit Egress */
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
    startedAt: { type: Date },
    endedAt: { type: Date },
    duration: { type: Number },
  },
  { timestamps: true }
);

chatCallSchema.index({ conversation: 1 });
chatCallSchema.index({ caller: 1 });
chatCallSchema.index({ createdAt: -1 });
chatCallSchema.plugin(toJSON);

export default mongoose.model('ChatCall', chatCallSchema);
