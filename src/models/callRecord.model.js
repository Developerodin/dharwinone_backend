import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const callRecordSchema = mongoose.Schema(
  {
    executionId: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      default: 'unknown',
      index: true,
    },
    phone: String,
    recipientPhoneNumber: String,
    toPhoneNumber: { type: String, trim: true },
    userNumber: String,
    fromPhoneNumber: { type: String, trim: true },
    businessName: { type: String, trim: true },
    language: { type: String, trim: true, default: null },
    transcript: String,
    conversationTranscript: String,
    duration: Number,
    recordingUrl: String,
    errorMessage: { type: String, default: null },
    completedAt: { type: Date, default: null },
    extractedData: mongoose.Schema.Types.Mixed,
    telephonyData: mongoose.Schema.Types.Mixed,
    purpose: { type: String, trim: true, default: null },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', default: null },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    raw: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

callRecordSchema.plugin(toJSON);

const CallRecord = mongoose.model('CallRecord', callRecordSchema);
export default CallRecord;

