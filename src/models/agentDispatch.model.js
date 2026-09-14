import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const agentDispatchSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
    dispatchId: { type: String, required: true, unique: true },
    // No default: a sparse index still indexes null, so a null default makes every keyless row (assistant, v1) collide.
    dispatchKey: { type: String, unique: true, sparse: true },
    agentIdentity: { type: String, default: null },
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
    /** Summary-agent cancel: LiveKit dispatch deleted but row stays active until finalize/salvage (F22). */
    cancelRequestedAt: { type: Date, default: null },
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
