import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const assignmentRowSchema = new mongoose.Schema(
  {
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssignmentRun',
      required: true,
      index: true,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
    },
    recommendedCandidateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
    },
    alternates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
    rank: { type: Number, default: 1 },
    scores: { type: mongoose.Schema.Types.Mixed },
    gap: { type: Boolean, default: false },
    recommendedJobDraft: { type: mongoose.Schema.Types.Mixed },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

assignmentRowSchema.index({ runId: 1, taskId: 1 }, { unique: true });

assignmentRowSchema.plugin(toJSON);

const AssignmentRow = mongoose.model('AssignmentRow', assignmentRowSchema);

export default AssignmentRow;
