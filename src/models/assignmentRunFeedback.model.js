import mongoose from 'mongoose';

/**
 * PM feedback on assignment run rows (ADR-0042) — for analytics and future few-shot use.
 */
const assignmentRunFeedbackSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssignmentRun', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientSubmittedAt: { type: Date, default: null },
    items: { type: [mongoose.Schema.Types.Mixed], required: true },
  },
  { timestamps: true }
);

assignmentRunFeedbackSchema.index({ runId: 1, createdAt: -1 }, { name: 'assignment_run_feedback_run_created' });

const AssignmentRunFeedback = mongoose.model('AssignmentRunFeedback', assignmentRunFeedbackSchema);

export default AssignmentRunFeedback;
