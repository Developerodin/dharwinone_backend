import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const runSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true },
    agentIdentity: { type: String, default: null },
    agentName: { type: String, default: null },
    protocolVersion: { type: Number, default: 2 },
    agentBuild: { type: String, default: null },
    sttProvider: { type: String, default: null },
    sttModel: { type: String, default: null },
    language: { type: String, default: 'en' },
    startedAtEpochMs: { type: Number, default: null },
    endedAtEpochMs: { type: Number, default: null },
    status: {
      type: String,
      enum: ['open', 'finalize_requested', 'finalized', 'lost'],
      default: 'open',
    },
    ackedBatchSeqs: { type: [Number], default: [] },
    missingBatchSeqs: { type: [Number], default: [] },
    batchCount: { type: Number, default: 0 },
    utteranceCount: { type: Number, default: 0 },
    sttStreamClosures: { type: Number, default: 0 },
    finalizeReason: { type: String, default: null },
    lastHeartbeatAt: { type: Date, default: null },
  },
  { _id: false }
);

const transcriptSessionSchema = new mongoose.Schema(
  {
    dispatchKey: { type: String, required: true, unique: true },
    meetingId: { type: String, required: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null, index: true },
    interviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', default: null },
    runs: { type: [runSchema], default: [] },
    status: {
      type: String,
      enum: ['open', 'finalize_requested', 'finalized', 'summary_queued', 'completed', 'failed'],
      default: 'open',
      index: true,
    },
    partial: { type: Boolean, default: false },
    partialReasons: { type: [String], default: [] },
    summaryQueuedAt: { type: Date, default: null },
    summaryJobId: { type: String, default: null },
    schemaVersion: { type: Number, default: 2 },
  },
  { timestamps: true }
);

transcriptSessionSchema.index({ status: 1, updatedAt: 1 });

transcriptSessionSchema.plugin(toJSON);

const TranscriptSession = mongoose.model('TranscriptSession', transcriptSessionSchema);
export default TranscriptSession;
