import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const agentDispatchSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
    dispatchId: { type: String, required: true, unique: true },
    agentName: { type: String, default: 'meeting-summary-agent' },
    status: {
      type: String,
      enum: ['requested', 'running', 'disconnected', 'failed', 'completed'],
      default: 'requested',
      index: true,
    },
    joinedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null },
    lastHeartbeat: { type: Date, default: null },
    lastSegmentSentAt: { type: Date, default: null },
    error: { type: String, default: null },
    hmacToken: { type: String, required: true },
    sttCostUsd: { type: Number, default: 0 },
  },
  { timestamps: true }
);

agentDispatchSchema.plugin(toJSON);

agentDispatchSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.hmacToken;
    return ret;
  },
});

const AgentDispatch = mongoose.model('AgentDispatch', agentDispatchSchema);
export default AgentDispatch;
