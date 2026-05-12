import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const utteranceSchema = new mongoose.Schema(
  {
    speaker: { type: String, default: null },
    speakerName: { type: String, default: null },
    speakerLabel: { type: String, default: null },
    speakerSource: {
      type: String,
      enum: ['livekit', 'deepgram', 'fallback'],
      default: 'livekit',
    },
    speakerConfidence: { type: Number, default: null },
    text: { type: String, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    confidence: { type: Number, default: null },
  },
  { _id: false }
);

const transcriptSegmentSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', index: true },
    sequenceNumber: { type: Number, required: true },
    windowStartMs: { type: Number, required: true },
    windowEndMs: { type: Number, required: true },
    combinedText: { type: String, required: true },
    utterances: { type: [utteranceSchema], default: [] },
    utteranceCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

transcriptSegmentSchema.index({ meetingId: 1, sequenceNumber: 1 }, { unique: true });
transcriptSegmentSchema.index({ meetingId: 1, windowStartMs: 1 });
transcriptSegmentSchema.index({ combinedText: 'text' });

transcriptSegmentSchema.plugin(toJSON);

const TranscriptSegment = mongoose.model('TranscriptSegment', transcriptSegmentSchema);
export default TranscriptSegment;
