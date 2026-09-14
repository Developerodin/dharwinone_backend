import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const utteranceSchema = new mongoose.Schema(
  {
    utteranceId: { type: String, required: true },
    participantIdentity: { type: String, required: true },
    participantSid: { type: String, default: null },
    trackSid: { type: String, default: null },
    displayName: { type: String, default: null },
    text: { type: String, required: true },
    confidence: { type: Number, default: null },
    language: { type: String, default: 'en' },
    sttStartSec: { type: Number, default: null },
    sttDurationSec: { type: Number, default: null },
    startedAtEpochMs: { type: Number, required: true },
    endedAtEpochMs: { type: Number, required: true },
    speakerRole: { type: String, default: null },
    speakerRef: { type: String, default: null },
    roleAssurance: { type: String, default: null },
  },
  { _id: false }
);

const transcriptBatchSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TranscriptSession', required: true },
    runId: { type: String, required: true },
    batchSeq: { type: Number, required: true },
    meetingId: { type: String, required: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null, index: true },
    utteranceIdsHash: { type: String, required: true },
    utterances: { type: [utteranceSchema], default: [] },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

transcriptBatchSchema.index({ sessionId: 1, runId: 1, batchSeq: 1 }, { unique: true });

transcriptBatchSchema.plugin(toJSON);

const TranscriptBatch = mongoose.model('TranscriptBatch', transcriptBatchSchema);
export default TranscriptBatch;
