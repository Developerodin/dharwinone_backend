import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const transcriptVersionSchema = new mongoose.Schema(
  {
    ownerKey: { type: String, required: true, trim: true, index: true },
    interviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', default: null, index: true },
    meetingId: { type: String, trim: true, default: null, index: true },
    version: { type: Number, required: true },
    sessionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TranscriptSession' }],
    s3Key: { type: String, required: true, trim: true },
    contentHash: { type: String, required: true, trim: true },
    utteranceCount: { type: Number, default: 0 },
    quality: {
      coverageRatio: { type: Number, default: null },
      maxGapMs: { type: Number, default: null },
      lowConfidenceShare: { type: Number, default: null },
    },
    evidenceGrade: {
      type: String,
      enum: ['full', 'partial', 'legacy', 'unsupported_language', 'truncated'],
      default: 'full',
    },
    partialReasons: { type: [String], default: [] },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true }
);

transcriptVersionSchema.index({ ownerKey: 1, version: 1 }, { unique: true });

transcriptVersionSchema.plugin(toJSON);

const TranscriptVersion = mongoose.model('TranscriptVersion', transcriptVersionSchema);
export default TranscriptVersion;
