import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const summaryDeadLetterSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
    jobId: { type: String, required: true, unique: true },
    attempts: { type: Number, required: true },
    lastError: { type: String, required: true },
    lastStack: { type: String, default: null },
    payload: { type: Object, required: true },
    movedToDlqAt: { type: Date, default: Date.now },
    replayedAt: { type: Date, default: null },
    replayJobId: { type: String, default: null },
  },
  { timestamps: false }
);

summaryDeadLetterSchema.plugin(toJSON);

const SummaryDeadLetter = mongoose.model('SummaryDeadLetter', summaryDeadLetterSchema);
export default SummaryDeadLetter;
