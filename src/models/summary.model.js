import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const actionItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    owner: { type: String, default: null },
    dueHint: { type: String, default: null },
    timestampMs: { type: Number, default: null },
  },
  { _id: false }
);

const decisionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    timestampMs: { type: Number, default: null },
  },
  { _id: false }
);

const participantActiveSchema = new mongoose.Schema(
  {
    identity: { type: String, default: null },
    name: { type: String, default: null },
    speakingMs: { type: Number, default: 0 },
  },
  { _id: false }
);

const summarySchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, unique: true, index: true },
    recordingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
    executiveSummary: { type: String, default: '' },
    bulletSummary: { type: [String], default: [] },
    actionItems: { type: [actionItemSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    blockers: { type: [String], default: [] },
    nextSteps: { type: [String], default: [] },
    participantsActive: { type: [participantActiveSchema], default: [] },
    durationMs: { type: Number, default: null },
    llmModelMix: { type: String, default: 'gpt-4o-mini+gpt-4o' },
    llmCostUsd: { type: Number, default: 0 },
    generatedAt: { type: Date, default: Date.now },
    version: { type: Number, default: 1 },
    partial: { type: Boolean, default: false },
  },
  { timestamps: true }
);

summarySchema.plugin(toJSON);

const Summary = mongoose.model('Summary', summarySchema);
export default Summary;
